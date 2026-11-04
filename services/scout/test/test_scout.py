"""Scout tests.

Two things are being protected here:

1. The parsing and ranking actually work (so the tool is useful).
2. The tool cannot become a harvesting pipeline (so the project stays worth
   building). The policy tests are the load-bearing ones.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
if str(SERVICE) not in sys.path:
    sys.path.insert(0, str(SERVICE))

from tandem_scout import policy, queue, signals, sources  # noqa: E402
from tandem_scout.models import Candidate, Observation  # noqa: E402
from tandem_scout.__main__ import load_replay, main  # noqa: E402

FIXTURES = HERE / "fixtures"
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)


def ago(days: float, hours: float = 0) -> str:
    return (NOW - timedelta(days=days, hours=hours)).isoformat()


def obs(source="hackernews", handle="someone", text="talking about ai", days=2.0, thread="t1", topic="ai"):
    return Observation(
        source=source,
        handle=handle,
        text=text,
        url=f"https://example.test/{handle}/{thread}",
        created_at=ago(days),
        topic=topic,
        extra={"thread": thread},
    )


# ------------------------------------------------------------------ policy ----

class TestPolicy(unittest.TestCase):
    def test_email_and_phone_are_redacted(self):
        cleaned, scrubbed = policy.scrub_pii("mail ada@example.com or call +1 (415) 555-0134 please")
        self.assertTrue(scrubbed)
        self.assertNotIn("ada@example.com", cleaned)
        self.assertNotIn("555-0134", cleaned)
        self.assertIn("[redacted]", cleaned)

    def test_clean_text_is_untouched(self):
        text = "we should add provenance to every detection rule"
        cleaned, scrubbed = policy.scrub_pii(text)
        self.assertFalse(scrubbed)
        self.assertEqual(cleaned, text)

    def test_ssn_like_strings_are_redacted(self):
        cleaned, scrubbed = policy.scrub_pii("my id is 123-45-6789")
        self.assertTrue(scrubbed)
        self.assertNotIn("123-45-6789", cleaned)

    def test_only_public_thread_invites_are_allowed(self):
        policy.assert_invite_channel("public_thread")
        for channel in ("dm", "email", "sms", "whatsapp", "phone"):
            with self.assertRaises(policy.PolicyViolation):
                policy.assert_invite_channel(channel)

    def test_unknown_sources_are_refused(self):
        policy.assert_source("hackernews")
        with self.assertRaises(policy.PolicyViolation):
            policy.assert_source("linkedin_scraper")

    def test_reddit_is_disabled_with_a_reason(self):
        self.assertIn("reddit", policy.DISABLED_SOURCES)
        self.assertIn("OAuth", policy.DISABLED_SOURCES["reddit"])

    def test_optout_matching_is_per_source_and_global(self):
        optouts = policy.load_optouts(_write_optouts(["global_person", "hackernews:local_person"]))
        self.assertTrue(policy.is_opted_out("global_person", "devto", optouts))
        self.assertTrue(policy.is_opted_out("local_person", "hackernews", optouts))
        self.assertFalse(policy.is_opted_out("local_person", "devto", optouts))

    def test_optout_file_comments_are_ignored(self):
        path = _write_optouts(["# a comment", "", "real_person  # inline note"])
        self.assertEqual(policy.load_optouts(path), {"real_person"})

    def test_policy_summary_names_what_is_never_collected(self):
        summary = policy.policy_summary()
        self.assertIn("phone numbers", summary["never_collects"])
        self.assertEqual(summary["allowed_invite_channels"], ["public_thread"])
        self.assertGreater(summary["caps"]["invites_per_run"], 0)


def _write_optouts(lines: list[str]) -> Path:
    handle = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
    handle.write("\n".join(lines))
    handle.close()
    return Path(handle.name)


# ----------------------------------------------------------------- signals ----

class TestSignals(unittest.TestCase):
    def test_phrases_map_to_canonical_groups(self):
        tags = signals.extract_interests("I work on machine learning and threat intel, mostly")
        self.assertIn("ai", tags)
        # "threat intel" folds onto the security-adjacent osint group in the shared vocabulary
        self.assertTrue({"security", "osint"} & set(tags), tags)

    def test_aliases_fold_together(self):
        self.assertEqual(signals.extract_interests("LLMs and deep-learning and ml"), ["ai"])

    def test_unknown_words_are_not_tags(self):
        self.assertEqual(signals.extract_interests("my cat knocked over the router again"), [])

    def test_interest_match_is_proportional(self):
        self.assertEqual(signals.interest_match(["ai", "security"], ["ai", "security"]), 1.0)
        self.assertEqual(signals.interest_match(["ai"], ["ai", "security"]), 0.5)
        self.assertEqual(signals.interest_match(["design"], ["ai"]), 0.0)
        self.assertEqual(signals.interest_match(["ai"], []), 0.0)

    def test_recent_activity_beats_volume(self):
        fresh = signals.activity_score([1, 3, 6])
        dusty = signals.activity_score([400, 500, 600, 700, 800, 900])
        self.assertGreater(fresh, dusty)

    def test_breadth_is_capped(self):
        self.assertEqual(signals.breadth_score(0), 0.0)
        self.assertEqual(signals.breadth_score(3), 1.0)
        self.assertEqual(signals.breadth_score(99), 1.0)

    def test_priority_weights_sum_to_one(self):
        self.assertAlmostEqual(signals.priority(1, 1, 1), 1.0)
        self.assertAlmostEqual(signals.priority(0, 0, 0), 0.0)

    def test_describe_names_the_source_and_recency(self):
        reasons = signals.describe("hackernews", ["ai"], 3, 2, ago(3), NOW)
        joined = " ".join(reasons)
        self.assertIn("ai", joined)
        self.assertIn("hackernews", joined)
        self.assertIn("this week", joined)


# ----------------------------------------------------------------- sources ----

def fake_http(payloads: dict[str, object]):
    def _get(url: str):
        for key, payload in payloads.items():
            if key in url:
                return payload
        raise AssertionError(f"unexpected url: {url}")

    return _get


class TestSourceAdapters(unittest.TestCase):
    def test_hackernews_payload(self):
        http = fake_http({
            "hn.algolia.com": {
                "hits": [
                    {"author": "pg", "title": "On lisp", "objectID": "1", "created_at": "2026-11-01T10:00:00Z",
                     "story_id": "1"},
                    {"author": None, "title": "deleted", "objectID": "2"},
                ]
            }
        })
        found = sources.HackerNewsSource().fetch("ai", 10, http)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].handle, "pg")
        self.assertIn("news.ycombinator.com", found[0].url)

    def test_hackernews_strips_html_from_comments(self):
        http = fake_http({
            "hn.algolia.com": {"hits": [{"author": "pg", "comment_text": "<p>hello <a href='x'>world</a></p>",
                                         "objectID": "9"}]}
        })
        found = sources.HackerNewsSource().fetch("ai", 10, http)
        self.assertNotIn("<", found[0].text)
        self.assertIn("hello", found[0].text)

    def test_devto_payload(self):
        http = fake_http({
            "dev.to/api": [{"user": {"username": "ines"}, "title": "notes", "tag_list": ["ai", "design"],
                            "url": "https://dev.to/ines/notes", "published_at": "2026-11-02T00:00:00Z"}]
        })
        found = sources.DevToSource().fetch("ai", 10, http)
        self.assertEqual(found[0].handle, "ines")
        self.assertIn("design", found[0].text)

    def test_github_payload_has_thread_identity(self):
        http = fake_http({
            "api.github.com": {"items": [{"user": {"login": "rusty"}, "title": "bug", "html_url": "https://github.com/a/b/issues/1",
                                          "repository_url": "https://api.github.com/repos/a/b", "number": 1,
                                          "created_at": "2026-11-03T00:00:00Z"}]}
        })
        found = sources.GitHubSource().fetch("security", 10, http)
        self.assertEqual(found[0].handle, "rusty")
        self.assertIn("#1", found[0].extra["thread"])

    def test_bluesky_payload_builds_a_post_url(self):
        http = fake_http({
            "public.api.bsky.app": {"posts": [{"author": {"handle": "someone.bsky.social"},
                                               "uri": "at://did:plc:x/app.bsky.feed.post/abc123",
                                               "record": {"text": "working on ai evals"},
                                               "indexedAt": "2026-11-03T00:00:00Z"}]}
        })
        found = sources.BlueskySource().fetch("ai", 10, http)
        self.assertEqual(found[0].url, "https://bsky.app/profile/someone.bsky.social/post/abc123")

    def test_reddit_is_inert_without_credentials(self):
        adapter = sources.RedditSource(enabled=False)
        self.assertEqual(adapter.fetch("ai", 10, fake_http({})), [])

    def test_collect_reports_disabled_sources_instead_of_crashing(self):
        observations, reports = sources.collect(
            ["ai"], ["reddit"], http=fake_http({}), pause_seconds=0
        )
        self.assertEqual(observations, [])
        self.assertEqual(reports[0].status, "disabled")
        self.assertIn("OAuth", reports[0].note)

    def test_collect_scrubs_contact_details_on_the_way_in(self):
        http = fake_http({
            "hn.algolia.com": {"hits": [{"author": "leaky", "comment_text": "reach me at a@b.com",
                                         "objectID": "5", "created_at": "2026-11-03T00:00:00Z"}]}
        })
        observations, reports = sources.collect(["ai"], ["hackernews"], http=http, pause_seconds=0)
        self.assertEqual(len(observations), 1)
        self.assertNotIn("a@b.com", observations[0].text)
        self.assertIn("redacted", reports[0].note)

    def test_collect_survives_a_broken_source(self):
        def broken(url: str):
            raise ValueError("upstream exploded")

        observations, reports = sources.collect(["ai"], ["hackernews"], http=broken, pause_seconds=0)
        self.assertEqual(observations, [])
        self.assertEqual(reports[0].status, "error")
        self.assertIn("upstream exploded", reports[0].note)


# ------------------------------------------------------------------- queue ----

class TestQueue(unittest.TestCase):
    def test_a_real_candidate_is_queued_with_evidence(self):
        observations = [
            obs(handle="builder", days=2, thread="t1"),
            obs(handle="builder", days=5, thread="t2"),
            obs(handle="builder", days=8, thread="t3", text="threat modelling for agents"),
        ]
        candidates, stats = queue.build_queue(observations, ["ai"], now=NOW, invite_url="https://t.example/join")
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].handle, "builder")
        self.assertEqual(candidates[0].threads, 3)
        self.assertGreater(candidates[0].priority, 0.3)
        self.assertEqual(stats["queued"], 1)
        self.assertTrue(candidates[0].evidence_urls)

    def test_one_drive_by_comment_is_not_a_candidate(self):
        candidates, stats = queue.build_queue([obs(handle="lurker")], ["ai"], now=NOW)
        self.assertEqual(candidates, [])
        self.assertEqual(stats["too_thin"], 1)

    def test_stale_activity_is_dropped(self):
        observations = [obs(handle="ghost", days=200, thread=f"t{i}") for i in range(4)]
        candidates, stats = queue.build_queue(observations, ["ai"], now=NOW)
        self.assertEqual(candidates, [])
        self.assertEqual(stats["stale"], 4)

    def test_optout_is_honoured(self):
        observations = [obs(handle="nothanks", days=1, thread=f"t{i}") for i in range(3)]
        candidates, stats = queue.build_queue(observations, ["ai"], now=NOW, optouts={"nothanks"})
        self.assertEqual(candidates, [])
        self.assertEqual(stats["opted_out"], 1)

    def test_the_same_handle_on_two_platforms_stays_two_candidates(self):
        observations = [
            obs(source="hackernews", handle="same", days=1, thread="a"),
            obs(source="hackernews", handle="same", days=2, thread="b"),
            obs(source="devto", handle="same", days=1, thread="c"),
            obs(source="devto", handle="same", days=3, thread="d"),
        ]
        candidates, _ = queue.build_queue(observations, ["ai"], now=NOW)
        self.assertEqual(len(candidates), 2)
        self.assertEqual({c.source for c in candidates}, {"hackernews", "devto"})

    def test_cap_is_applied(self):
        observations = []
        for index in range(60):
            for thread in range(3):
                observations.append(obs(handle=f"person{index}", days=1, thread=f"t{index}{thread}"))
        candidates, stats = queue.build_queue(observations, ["ai"], now=NOW, cap=10)
        self.assertEqual(len(candidates), 10)
        self.assertEqual(stats["queued"], 10)

    def test_ranking_puts_relevant_active_people_first(self):
        observations = [
            obs(handle="onfocus", days=1, thread="t1", text="deep in ai evals and agents"),
            obs(handle="onfocus", days=2, thread="t2", text="more ai"),
            obs(handle="offfocus", days=1, thread="t3", text="marathon training and guitar"),
            obs(handle="offfocus", days=2, thread="t4", text="more guitar"),
        ]
        candidates, _ = queue.build_queue(observations, ["ai"], now=NOW)
        self.assertEqual(candidates[0].handle, "onfocus")

    def test_draft_is_human_sized_and_honest(self):
        candidate = Candidate(
            source="hackernews", handle="builder", profile_url="https://news.ycombinator.com/user?id=builder",
            interests=["ai"], observations=3, threads=2, last_seen=ago(2), priority=0.7,
            why=["writes about ai"], evidence_urls=["https://news.ycombinator.com/item?id=1"],
            invite_url="https://news.ycombinator.com/item?id=1",
        )
        draft = queue.invite_draft(candidate, "https://t.example/join")
        self.assertLess(len(draft), 600)
        self.assertIn("https://t.example/join", draft)
        self.assertIn("opt-in", draft)
        self.assertIn("won't follow up", draft)
        self.assertNotIn("@", draft.replace(candidate.handle, ""))

    def test_draft_refuses_a_dm_channel(self):
        candidate = Candidate(
            source="hackernews", handle="x", profile_url="", interests=[], observations=2, threads=2,
            last_seen="", priority=0.5, why=[], evidence_urls=[], invite_channel="dm",
        )
        with self.assertRaises(policy.PolicyViolation):
            queue.invite_draft(candidate, "https://t.example/join")

    def test_digest_warns_against_bulk_sending(self):
        text = queue.render_digest([], {}, [{"source": "hackernews", "status": "ok", "observations": "0"}],
                                   ["ai"], "now")
        self.assertIn("not a send list for a script", text)
        self.assertIn("Nothing cleared the bar", text)


# -------------------------------------------------------------- end to end ----

class TestReplayEndToEnd(unittest.TestCase):
    def test_replay_loads_fixtures_without_rotting(self):
        observations = load_replay(FIXTURES)
        self.assertGreater(len(observations), 5)
        self.assertTrue(all(o.created_at for o in observations))
        recent = [o for o in observations if o.age_days() < 30]
        self.assertTrue(recent, "fixtures should look recent thanks to age_days")

    def test_full_run_writes_queue_and_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = main([
                "--replay", str(FIXTURES),
                "--out", tmp,
                "--topics", "ai,security",
                "--optout", str(Path(tmp) / "none.txt"),
            ])
            self.assertEqual(code, 0)

            queue_payload = json.loads((Path(tmp) / "queue.json").read_text())
            digest = (Path(tmp) / "digest.md").read_text()

            handles = {candidate["handle"] for candidate in queue_payload["candidates"]}
            self.assertIn("realtimearcher", handles)
            self.assertIn("rustysec", handles)
            self.assertNotIn("drivebycommenter", handles, "one comment is not enough")
            self.assertNotIn("oldprolific", handles, "stale activity should not be queued")

            # the person who pasted their email must still be listed, but scrubbed
            if "dmmeplz" in handles:
                entry = next(c for c in queue_payload["candidates"] if c["handle"] == "dmmeplz")
                self.assertNotIn("gmail.com", json.dumps(entry))
                self.assertNotIn("555", json.dumps(entry))

            self.assertIn("Tandem scout digest", digest)
            self.assertIn("public thread only", digest)
            self.assertEqual(queue_payload["policy"]["allowed_invite_channels"], ["public_thread"])

    def test_run_without_a_mode_is_refused(self):
        self.assertEqual(main(["--topics", "ai"]), 2)


# -------------------------------------------------- public vs private groups ----

class TestSurfaces(unittest.TestCase):
    """The amendment: public groups yes, private groups no, and the line is
    'did the people posting choose a space strangers can read'."""

    def test_open_endpoints_are_public_surfaces(self):
        for source in ("hackernews", "devto", "github", "bluesky"):
            self.assertEqual(policy.surface_of(source), "public_surface")

    def test_channels_and_servers_are_public_groups(self):
        for source in ("telegram_public", "reddit", "discord", "facebook"):
            self.assertEqual(policy.surface_of(source), "public_group")

    def test_private_surfaces_are_refused_by_name(self):
        for kind in ("direct_message", "members_only", "invite_only", "paid", "group_member_list"):
            with self.assertRaises(policy.PolicyViolation):
                policy.assert_surface(kind)

    def test_unknown_surface_is_refused(self):
        with self.assertRaises(policy.PolicyViolation):
            policy.assert_surface("sort_of_public")
        with self.assertRaises(policy.PolicyViolation):
            policy.surface_of("some_new_scraper")

    def test_a_group_must_publish_its_own_join_link(self):
        policy.assert_group_admitted("https://t.me/examplebuilders", True)
        with self.assertRaises(policy.PolicyViolation):
            policy.assert_group_admitted("", True)
        with self.assertRaises(policy.PolicyViolation):
            policy.assert_group_admitted("tg://private_invite/abc", True)

    def test_a_group_must_be_readable_without_joining(self):
        with self.assertRaises(policy.PolicyViolation) as caught:
            policy.assert_group_admitted("https://t.me/closed", False)
        self.assertIn("not readable without joining", str(caught.exception))

    def test_member_lists_are_never_read(self):
        with self.assertRaises(policy.PolicyViolation) as caught:
            policy.assert_group_admitted("https://t.me/examplebuilders", True, member_scrape=True)
        self.assertIn("not a lead list", str(caught.exception))

    def test_a_group_is_not_a_person(self):
        for source in policy.GROUP_SOURCES:
            self.assertFalse(policy.produces_individuals(source), source)
        for source in ("hackernews", "devto", "github", "bluesky"):
            self.assertTrue(policy.produces_individuals(source), source)

    def test_policy_summary_states_the_group_line(self):
        summary = policy.policy_summary()
        self.assertEqual(summary["surfaces"]["reads_note"], "public groups yes, private groups no")
        self.assertIn("invite_only", summary["surfaces"]["never_reads"])
        self.assertIn("telegram_public", summary["group_sources"])


def _fixture_text_get(url: str) -> str:
    if "/s/examplebuilders" in url:
        return (FIXTURES / "telegram_public.html").read_text()
    if "/s/closedchannel" in url:
        return "<html><body><div>This channel is private</div></body></html>"
    raise AssertionError(f"unexpected url: {url}")


class TestTelegramPublicGroups(unittest.TestCase):
    def test_parses_a_public_preview(self):
        adapter = sources.TelegramPublicChannelSource()
        found = adapter.fetch_channel("@examplebuilders", 10, _fixture_text_get)
        self.assertEqual(len(found), 3)
        self.assertEqual(found[0].handle, "examplebuilders")
        self.assertEqual(found[0].url, "https://t.me/examplebuilders/101")
        self.assertEqual(found[0].created_at, "2026-11-01T09:00:00+00:00")
        self.assertIn("evals harness", found[0].text)
        self.assertNotIn("<b>", found[0].text, "html must be stripped")
        self.assertEqual(found[0].extra["surface"], "public_group")
        self.assertEqual(found[0].extra["join_url"], "https://t.me/examplebuilders")

    def test_respects_the_limit(self):
        adapter = sources.TelegramPublicChannelSource()
        self.assertEqual(len(adapter.fetch_channel("examplebuilders", 2, _fixture_text_get)), 2)

    def test_a_channel_without_a_public_preview_is_refused(self):
        adapter = sources.TelegramPublicChannelSource()
        with self.assertRaises(ValueError) as caught:
            adapter.fetch_channel("closedchannel", 10, _fixture_text_get)
        self.assertIn("not a public group", str(caught.exception))

    def test_channel_handles_are_validated(self):
        adapter = sources.TelegramPublicChannelSource()
        for handle in ("../etc/passwd", "a b", "x", ""):
            with self.assertRaises(ValueError):
                adapter.fetch_channel(handle, 10, _fixture_text_get)

    def test_group_source_without_channels_asks_for_them(self):
        observations, reports = sources.collect(
            ["ai"], ["telegram_public"], http=fake_http({}), text_get=_fixture_text_get, pause_seconds=0
        )
        self.assertEqual(observations, [])
        self.assertEqual(reports[0].status, "needs-channels")
        self.assertIn("--channels", reports[0].note)

    def test_group_source_reports_what_it_read(self):
        observations, reports = sources.collect(
            ["ai"], ["telegram_public"], http=fake_http({}), text_get=_fixture_text_get,
            channels=["examplebuilders"], pause_seconds=0,
        )
        self.assertEqual(len(observations), 3)
        self.assertEqual(reports[0].status, "ok")
        self.assertIn("public group", reports[0].note)
        self.assertTrue(all(o.extra["surface"] == "public_group" for o in observations))


class TestGroupSignalsAreNotLeads(unittest.TestCase):
    def test_group_posts_never_become_invite_candidates(self):
        observations = [
            Observation(source="telegram_public", handle="examplebuilders", text="ai and security",
                        url="https://t.me/examplebuilders/1", created_at=ago(1), extra={"thread": "tg:1"}),
            Observation(source="telegram_public", handle="examplebuilders", text="more ai",
                        url="https://t.me/examplebuilders/2", created_at=ago(2), extra={"thread": "tg:2"}),
        ]
        candidates, stats = queue.build_queue(observations, ["ai"], now=NOW)
        self.assertEqual(candidates, [], "you cannot invite a channel")
        self.assertEqual(stats["group_signal"], 2)
        self.assertEqual(stats["queued"], 0)

    def test_group_digest_describes_communities_not_people(self):
        observations = [
            Observation(source="telegram_public", handle="examplebuilders", text="evals for ai agents",
                        url="https://t.me/examplebuilders/1", created_at=ago(1),
                        extra={"thread": "tg:1", "join_url": "https://t.me/examplebuilders"}),
            Observation(source="telegram_public", handle="examplebuilders", text="threat modelling and security",
                        url="https://t.me/examplebuilders/2", created_at=ago(3),
                        extra={"thread": "tg:2", "join_url": "https://t.me/examplebuilders"}),
        ]
        groups = queue.build_group_digest(observations, ["ai"], now=NOW)
        self.assertEqual(len(groups), 1)
        entry = groups[0]
        self.assertEqual(entry["handle"], "examplebuilders")
        self.assertEqual(entry["join_url"], "https://t.me/examplebuilders")
        self.assertEqual(entry["posts"], 2)
        self.assertIn("ai", entry["interests"])
        self.assertGreater(entry["posts_per_week"], 0)
        self.assertNotIn("draft", entry, "a group never gets an invite draft")

    def test_a_quiet_group_is_flagged_not_queued(self):
        observations = [
            Observation(source="telegram_public", handle="sleepy", text="ai",
                        url="https://t.me/sleepy/1", created_at=ago(40), extra={"thread": "tg:1"}),
            Observation(source="telegram_public", handle="sleepy", text="ai",
                        url="https://t.me/sleepy/2", created_at=ago(44), extra={"thread": "tg:2"}),
        ]
        groups = queue.build_group_digest(observations, ["ai"], now=NOW)
        self.assertTrue(groups[0]["quiet"])

    def test_stale_group_posts_are_dropped(self):
        observations = [
            Observation(source="telegram_public", handle="gone", text="ai",
                        url="https://t.me/gone/1", created_at=ago(200), extra={"thread": "tg:1"}),
        ]
        self.assertEqual(queue.build_group_digest(observations, ["ai"], now=NOW), [])

    def test_digest_has_a_community_section_and_no_invites_for_groups(self):
        groups = [{"source": "telegram_public", "handle": "examplebuilders",
                   "join_url": "https://t.me/examplebuilders", "posts": 3, "posts_per_week": 2.1,
                   "interests": ["ai", "security"], "last_seen": "", "quiet": False, "why": []}]
        text = queue.render_digest([], {"queued": 0}, [], ["ai"], "now", groups)
        self.assertIn("## Public groups", text)
        self.assertIn("Private groups are never read", text)
        self.assertIn("https://t.me/examplebuilders", text)
        self.assertNotIn("```", text.split("## Public groups")[1].split("## Funnel")[0])

    def test_replay_end_to_end_writes_groups_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            code = main([
                "--replay", str(FIXTURES), "--out", tmp, "--topics", "ai",
                "--optout", str(Path(tmp) / "none.txt"),
            ])
            self.assertEqual(code, 0)
            payload = json.loads((Path(tmp) / "groups.json").read_text())
            self.assertIn("groups", payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)


# ------------------------------------------------- self-declared handles ----

class TestMemberEnrichment(unittest.TestCase):
    """The consented path: read a person's own accounts, on their say-so."""

    def _http(self, mapping):
        def get(url: str):
            for fragment, payload in mapping.items():
                if fragment in url:
                    return payload
            raise AssertionError(f"unexpected url: {url}")
        return get

    def test_github_repos_become_interest_tags(self):
        from tandem_scout import members
        http = self._http({
            "/repos": [
                {"name": "evals", "description": "llm eval harness in python", "language": "Python",
                 "topics": ["ai"], "html_url": "https://github.com/x/evals"},
                {"name": "forked", "fork": True, "description": "ignore me"},
            ]
        })
        result = members.enrich_member(members.MemberHandle("p1", "github", "x"), http)
        self.assertIn("ai", result.interests)
        self.assertEqual(result.observations, 1, "forks are skipped")
        self.assertEqual(result.evidence_urls, ["https://github.com/x/evals"])

    def test_hackernews_comments_are_read_for_the_declared_author(self):
        from tandem_scout import members
        captured = {}

        def get(url):
            captured["url"] = url
            return {"hits": [{"comment_text": "threat modelling for agents", "objectID": "1"}]}

        result = members.enrich_member(members.MemberHandle("p2", "hackernews", "pg"), get)
        self.assertIn("author_pg", captured["url"], "we ask for that author, not a topic search")
        self.assertEqual(result.observations, 1)
        self.assertTrue(result.interests, "a comment about agents should produce at least one tag")

    def test_declared_but_unreadable_networks_say_so(self):
        from tandem_scout import members
        result = members.enrich_member(members.MemberHandle("p3", "mastodon", "a@b.social"))
        self.assertEqual(result.interests, [])
        self.assertIn("no reader", result.errors[0])

    def test_a_failing_platform_does_not_stop_the_others(self):
        from tandem_scout import members

        def get(url):
            if "/repos" in url:
                raise ValueError("github down")
            return [{"title": "notes", "tag_list": ["security"], "url": "https://dev.to/x/1"}]

        results = [
            members.enrich_member(members.MemberHandle("p4", "github", "x"), get),
            members.enrich_member(members.MemberHandle("p4", "devto", "x"), get),
        ]
        merged = members.merge_member_signals(results)["p4"]
        self.assertIn("security", merged.interests)
        self.assertTrue(merged.errors, "the failure is reported, not swallowed")

    def test_two_networks_agreeing_rank_higher_than_one(self):
        from tandem_scout import members
        http = self._http({
            "/repos": [{"name": "a", "description": "ai agents", "html_url": "https://github.com/x/a"}],
            "/articles": [{"title": "ai evals", "tag_list": ["ai"], "url": "https://dev.to/x/1"}],
            "getAuthorFeed": {"feed": [{"post": {"uri": "at://d/app.bsky.feed.post/r1",
                                         "record": {"text": "design notes"}}}]},
        })
        results = [
            members.enrich_member(members.MemberHandle("p5", "github", "x"), http),
            members.enrich_member(members.MemberHandle("p5", "devto", "x"), http),
            members.enrich_member(members.MemberHandle("p5", "bluesky", "x"), http),
        ]
        merged = members.merge_member_signals(results)["p5"]
        self.assertIn("ai", merged.interests, "the tag both accounts share survives the merge")
        self.assertEqual(merged.sources, ["bluesky", "devto", "github"])
        self.assertEqual(len(merged.interests), len(set(merged.interests)), "no duplicate tags")

    def test_contact_details_are_scrubbed_before_tagging(self):
        from tandem_scout import members
        http = self._http({"/articles": [{"title": "ai work, mail me at a@b.com", "tag_list": []}]})
        result = members.enrich_member(members.MemberHandle("p6", "devto", "x"), http)
        self.assertNotIn("@b.com", " ".join(result.interests) + str(result.evidence_urls))
        self.assertIn("ai", result.interests)

    def test_member_signals_never_become_an_invite(self):
        from tandem_scout import members
        http = self._http({"/repos": [{"name": "a", "description": "ai", "html_url": "https://github.com/x/a"}]})
        result = members.enrich_member(members.MemberHandle("p7", "github", "x"), http)
        self.assertNotIn("draft", result.to_payload())
        self.assertEqual(set(result.to_payload()), {"person_id", "interests", "observations", "sources", "evidence_urls"})
