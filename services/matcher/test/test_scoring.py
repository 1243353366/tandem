"""Tests for the matching engine.

These are the tests that matter for product honesty: they pin the behaviours
that would otherwise drift into "black box gives you a number".
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tandem_matcher import scoring, vocab  # noqa: E402
from tandem_matcher.scoring import Profile, match, score_pair  # noqa: E402


def person(**overrides):
    base = {
        "id": "p1",
        "display_name": "Base",
        "timezone": "America/New_York",
        "interests": ["ai", "security"],
        "current_project": "Building something",
        "project_tags": ["python"],
        "hours_per_week": 6,
        "looking_for": ["collaborator"],
        "offers": ["collaborator"],
        "comm_style": {"pace": "async", "directness": 3, "group_size": "small",
                       "prefers": ["text"]},
        "verified": True,
        "visibility": "searchable",
    }
    base.update(overrides)
    return base


class TestVocabulary(unittest.TestCase):
    def test_aliases_collapse(self):
        for alias in ("ML", "machine-learning", "llms", "AI ", "artificial intelligence"):
            self.assertEqual(vocab.canonical_tag(alias), "ai", alias)

    def test_unknown_tags_survive_normalization(self):
        self.assertEqual(vocab.canonical_tag("  Urban Gardening!! "), "urban-gardening")

    def test_non_strings_are_dropped(self):
        self.assertEqual(vocab.canonical_tag(None), "")
        self.assertEqual(vocab.canonical_tag({"nope": 1}), "")

    def test_role_aliases(self):
        self.assertEqual(vocab.clean_role("co-founder"), "cofounder")
        self.assertEqual(vocab.clean_role("Study Partner"), "study_partner")
        self.assertEqual(vocab.clean_role("accountability"), "accountability")
        self.assertIsNone(vocab.clean_role("pen pal"))

    def test_display_tags_accept_commas(self):
        profile = Profile.from_json(person(interests="ai, security; music"))
        self.assertEqual(profile.interests, {"ai", "security", "music"})


class TestGoalFactor(unittest.TestCase):
    def test_peer_match_scores_full(self):
        a = Profile.from_json(person(id="a", looking_for=["cofounder"]))
        b = Profile.from_json(person(id="b", looking_for=["cofounder"]))
        self.assertEqual(scoring.goal_factor(a, b)[0], 1.0)

    def test_mentor_mentee_is_complementary(self):
        a = Profile.from_json(person(id="a", looking_for=["mentor"], offers=[]))
        b = Profile.from_json(person(id="b", looking_for=["mentee"], offers=[]))
        self.assertEqual(scoring.goal_factor(a, b)[0], 1.0)

    def test_two_mentees_are_not_a_pair(self):
        a = Profile.from_json(person(id="a", looking_for=["mentee"], offers=[]))
        b = Profile.from_json(person(id="b", looking_for=["mentee"], offers=[]))
        self.assertLess(scoring.goal_factor(a, b)[0], 0.2)

    def test_one_way_desire_is_capped(self):
        a = Profile.from_json(person(id="a", looking_for=["cofounder"], offers=[]))
        b = Profile.from_json(person(id="b", looking_for=["friend"], offers=[]))
        result = score_pair(a, b)
        self.assertLessEqual(result.score, scoring.ONEWAY_CAP)
        self.assertIn("No goal in common", result.blockers)

    def test_fill_covers_asymmetric_offer(self):
        # A wants a mentor; B does not want a mentor but offers to mentor.
        a = Profile.from_json(person(id="a", looking_for=["mentor"], offers=[]))
        b = Profile.from_json(person(id="b", looking_for=["friend"], offers=["mentor"]))
        self.assertEqual(scoring.goal_factor(a, b)[0], 1.0)

    def test_missing_goal_is_reported_distinctly(self):
        a = Profile.from_json(person(id="a", looking_for=[]))
        b = Profile.from_json(person(id="b", looking_for=["friend"]))
        _, _, blockers = scoring.goal_factor(a, b)
        self.assertIn("One of you has not said what you are looking for", blockers)


class TestInterests(unittest.TestCase):
    def test_alias_forms_count_as_shared(self):
        a = Profile.from_json(person(id="a", interests=["machine learning"]))
        b = Profile.from_json(person(id="b", interests=["AI"]))
        self.assertGreater(scoring.interest_factor(a, b)[0], 0.0)
        self.assertEqual(a.interests & b.interests, {"ai"})

    def test_disjoint_interests_flagged(self):
        a = Profile.from_json(person(id="a", interests=["music"], project_tags=["figma"]))
        b = Profile.from_json(person(id="b", interests=["cycling"], project_tags=["terraform"]))
        value, _, blockers = scoring.interest_factor(a, b)
        self.assertEqual(value, 0.0)
        self.assertIn("No shared interests", blockers)

    def test_project_tags_add_signal(self):
        a = Profile.from_json(person(id="a", interests=["music"], project_tags=["rust"]))
        b = Profile.from_json(person(id="b", interests=["cycling"], project_tags=["rust"]))
        self.assertGreater(scoring.interest_factor(a, b)[0], 0.0)


class TestAvailability(unittest.TestCase):
    def test_similar_hours_score_well(self):
        a = Profile.from_json(person(id="a", hours_per_week=6))
        b = Profile.from_json(person(id="b", hours_per_week=5))
        self.assertGreaterEqual(scoring.availability_factor(a, b)[0], 0.85)

    def test_wild_mismatch_flagged(self):
        a = Profile.from_json(person(id="a", hours_per_week=2))
        b = Profile.from_json(person(id="b", hours_per_week=30))
        _, _, blockers = scoring.availability_factor(a, b)
        self.assertTrue(any("Availability mismatch" in b for b in blockers))

    def test_unknown_hours_are_neutral_not_fatal(self):
        a = Profile.from_json(person(id="a", hours_per_week=0))
        b = Profile.from_json(person(id="b", hours_per_week=8))
        value, _, blockers = scoring.availability_factor(a, b)
        self.assertEqual(value, 0.35)
        self.assertTrue(blockers)


class TestCommunication(unittest.TestCase):
    def test_sync_vs_async_is_a_blocker(self):
        a = Profile.from_json(person(id="a", comm_style={"pace": "async"}))
        b = Profile.from_json(person(id="b", comm_style={"pace": "sync"}))
        _, _, blockers = scoring.communication_factor(a, b)
        self.assertTrue(any("Rhythm clash" in b for b in blockers))

    def test_invalid_pace_falls_back_to_mixed(self):
        profile = Profile.from_json(person(comm_style={"pace": "telepathic"}))
        self.assertEqual(profile.pace, "mixed")

    def test_directness_is_clamped(self):
        profile = Profile.from_json(person(comm_style={"directness": 99}))
        self.assertEqual(profile.directness, 5)


class TestTimezone(unittest.TestCase):
    def test_offsets_resolve(self):
        self.assertIsNotNone(scoring.utc_offset_hours("America/New_York"))
        self.assertEqual(scoring.utc_offset_hours("UTC"), 0.0)

    def test_missing_timezone_is_neutral(self):
        a = Profile.from_json(person(id="a", timezone=None))
        b = Profile.from_json(person(id="b", timezone=None))
        self.assertEqual(scoring.timezone_factor(a, b)[0], 0.5)

    def test_nested_location_timezone_is_read(self):
        profile = Profile.from_json({"id": "x", "location": {"timezone": "Europe/Berlin"}})
        self.assertEqual(profile.timezone, "Europe/Berlin")


class TestCaps(unittest.TestCase):
    def test_unverified_pair_is_capped(self):
        a = Profile.from_json(person(id="a", verified=False))
        b = Profile.from_json(person(id="b", verified=True))
        result = score_pair(a, b)
        self.assertLessEqual(result.score, scoring.UNVERIFIED_CAP)
        self.assertIn("Identity not both verified", result.blockers)

    def test_verified_strong_pair_clears_floor(self):
        a = Profile.from_json(person(id="a"))
        b = Profile.from_json(person(id="b"))
        self.assertGreater(score_pair(a, b).score, scoring.DISPLAY_FLOOR)

    def test_score_is_deterministic(self):
        a = Profile.from_json(person(id="a"))
        b = Profile.from_json(person(id="b"))
        self.assertEqual([score_pair(a, b).score for _ in range(5)],
                         [score_pair(a, b).score] * 5)

    def test_breakdown_covers_every_weight(self):
        payload = score_pair(
            Profile.from_json(person(id="a")), Profile.from_json(person(id="b"))
        ).to_json()
        self.assertEqual(set(payload["breakdown"]), set(scoring.WEIGHTS))
        for name, part in payload["breakdown"].items():
            self.assertAlmostEqual(
                part["contribution"], part["value"] * part["weight"], places=4, msg=name
            )


class TestRanking(unittest.TestCase):
    def test_self_is_never_returned(self):
        me = person(id="me")
        out = match(me, [me, person(id="other")])
        self.assertEqual([m["person_id"] for m in out["matches"]], ["other"])

    def test_unlisted_candidates_are_hidden(self):
        out = match(person(id="me"), [person(id="shy", visibility="unlisted")])
        self.assertEqual(out["matches"], [])

    def test_unlisted_can_be_included_explicitly(self):
        out = match(person(id="me"), [person(id="shy", visibility="unlisted")],
                    include_unlisted=True)
        self.assertEqual(len(out["matches"]), 1)

    def test_better_match_ranks_first(self):
        me = person(id="me", interests=["ai", "security", "python"],
                    looking_for=["cofounder"], project_tags=["python"])
        good = person(id="good", interests=["ai", "security"],
                      looking_for=["cofounder"], project_tags=["python"])
        weak = person(id="weak", interests=["music", "cycling"],
                      looking_for=["friend"], project_tags=["guitar"],
                      hours_per_week=30)
        out = match(me, [weak, good])
        self.assertEqual(out["matches"][0]["person_id"], "good")
        self.assertTrue(out["matches"][0]["reasons"])

    def test_limit_is_respected_and_bounded(self):
        candidates = [person(id=f"c{i}") for i in range(40)]
        self.assertEqual(len(match(person(id="me"), candidates, limit=5)["matches"]), 5)
        self.assertLessEqual(len(match(person(id="me"), candidates, limit=9999)["matches"]), 40)

    def test_engine_version_is_reported(self):
        out = match(person(id="me"), [person(id="c")])
        self.assertEqual(out["engine_version"], vocab.ENGINE_VERSION)


class TestMalformedInput(unittest.TestCase):
    def test_missing_fields_do_not_raise(self):
        out = match({}, [{"id": "x"}])
        self.assertEqual(out["person_id"], "")

    def test_junk_roles_are_ignored(self):
        out = match(person(id="me"), [person(id="c", looking_for=["overlord"])])
        self.assertEqual(out["matches"], [])

    def test_hours_are_clamped(self):
        self.assertEqual(Profile.from_json(person(hours_per_week=-40)).hours_per_week, 0)
        self.assertEqual(Profile.from_json(person(hours_per_week=9999)).hours_per_week, 80)


if __name__ == "__main__":
    unittest.main(verbosity=2)
