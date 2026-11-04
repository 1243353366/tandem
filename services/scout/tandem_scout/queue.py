"""Aggregation and invitation drafting.

The output of a scout run is not a contact list. It is a short, ranked queue of
public handles, each with the evidence that put it there and a draft message you
are expected to post yourself, in public, in the thread where the signal was seen.

That constraint is the feature. A human posting one honest reply in a thread is
welcome. A machine posting twenty invites is spam, and Tandem would deserve the
ban.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .models import Candidate, Observation
from . import policy, signals


def invite_draft(candidate: Candidate, invite_url: str) -> str:
    """A reply you could plausibly post under your own name.

    Kept short, kept honest, and it names the opt-out in the message itself so
    nobody has to hunt for it.
    """
    evidence = candidate.evidence_urls[0] if candidate.evidence_urls else ""
    interest = candidate.interests[0] if candidate.interests else "this"
    lines = [
        f"Hi {candidate.handle} — your {interest} post on {candidate.source}"
        + (f" ({evidence})" if evidence else "")
        + " is the kind of thing I'm looking for.",
        "I'm building Tandem: a small opt-in place to find project partners for exactly",
        "that kind of work. No phone number needed, and it publishes what it stores",
        f"before you sign anything: {invite_url}",
        "If it's not for you, ignore this and I won't follow up.",
    ]
    draft = "\n".join(lines)
    policy.assert_invite_channel(candidate.invite_channel)
    return draft


def build_queue(
    observations: Iterable[Observation],
    topics: list[str],
    optouts: set[str] | None = None,
    now: datetime | None = None,
    cap: int = policy.MAX_INVITES_PER_RUN,
    invite_url: str = "",
) -> tuple[list[Candidate], dict[str, int]]:
    """Group observations by public handle and rank the ones worth a human's time."""
    now = now or datetime.now(timezone.utc)
    optouts = optouts or set()
    stats = {"seen": 0, "stale": 0, "opted_out": 0, "too_thin": 0, "queued": 0}

    grouped: dict[tuple[str, str], list[Observation]] = {}
    for observation in observations:
        stats["seen"] += 1
        if observation.age_days(now) > policy.MAX_AGE_DAYS:
            stats["stale"] += 1
            continue
        key = (observation.source, observation.handle)
        bucket = grouped.setdefault(key, [])
        if len(bucket) < policy.MAX_OBSERVATIONS_PER_HANDLE:
            bucket.append(observation)

    candidates: list[Candidate] = []
    for (source, handle), items in grouped.items():
        if not handle:
            continue
        if policy.is_opted_out(handle, source, optouts):
            stats["opted_out"] += 1
            continue

        threads = len({item.extra.get("thread") or item.url for item in items})
        if len(items) < policy.MIN_OBSERVATIONS or threads < policy.MIN_THREADS:
            stats["too_thin"] += 1
            continue

        # Deliberately NOT including item.topic here. The topic is the query that
        # surfaced this person, so feeding it back into interest extraction would
        # make every candidate look interested in whatever we searched for.
        text = " ".join(item.text for item in items)
        interests = signals.extract_interests(text)
        ages = [item.age_days(now) for item in items]
        last_seen = max((item.created_at for item in items), default="")
        ordered = sorted(items, key=lambda item: item.created_at, reverse=True)

        score = signals.priority(
            signals.interest_match(interests, topics),
            signals.activity_score(ages),
            signals.breadth_score(threads),
        )

        candidate = Candidate(
            source=source,
            handle=handle,
            profile_url=_profile_url(source, handle),
            interests=interests,
            observations=len(items),
            threads=threads,
            last_seen=last_seen,
            priority=score,
            why=signals.describe(source, interests, len(items), threads, last_seen, now),
            evidence_urls=[item.url for item in ordered if item.url][:3],
            invite_channel="public_thread",
            invite_url=ordered[0].url if ordered else "",
        )
        candidate.draft = invite_draft(candidate, invite_url)
        candidates.append(candidate)

    candidates.sort(key=lambda candidate: (-candidate.priority, candidate.handle.lower()))
    if len(candidates) > policy.MAX_QUEUE_SIZE:
        candidates = candidates[: policy.MAX_QUEUE_SIZE]
    candidates = candidates[: max(0, cap)]
    stats["queued"] = len(candidates)
    return candidates, stats


def _profile_url(source: str, handle: str) -> str:
    if source == "hackernews":
        return f"https://news.ycombinator.com/user?id={handle}"
    if source == "github":
        return f"https://github.com/{handle}"
    if source == "devto":
        return f"https://dev.to/{handle}"
    if source == "bluesky":
        return f"https://bsky.app/profile/{handle}"
    if source == "reddit":
        return f"https://www.reddit.com/user/{handle}"
    return ""


def render_digest(
    candidates: list[Candidate],
    stats: dict[str, int],
    reports: list[dict[str, str]],
    topics: list[str],
    generated_at: str,
) -> str:
    """A human-readable summary for whoever is about to send one of these."""
    lines = [
        "# Tandem scout digest",
        "",
        f"Generated {generated_at} · topics: {', '.join(topics) or '(none)'}",
        "",
        "This is a queue for a human, not a send list for a script. Post at most a",
        "couple of these a day, in the thread linked on each one. Never copy an invite",
        "into a DM.",
        "",
        "## Sources",
        "",
        "| source | status | observations | note |",
        "| --- | --- | --- | --- |",
    ]
    for report in reports:
        lines.append(
            f"| {report.get('source', '?')} | {report.get('status', '?')} | "
            f"{report.get('observations', 0)} | {report.get('note', '') or ''} |"
        )

    lines += [
        "",
        "## Funnel",
        "",
        " · ".join(f"{key}: {value}" for key, value in stats.items()),
        "",
        f"## Queue ({len(candidates)})",
        "",
    ]

    for index, candidate in enumerate(candidates, start=1):
        lines.append(f"### {index}. {candidate.handle} · {candidate.source} · priority {candidate.priority:.2f}")
        lines.append("")
        lines.append(f"- profile: {candidate.profile_url}")
        lines.append(f"- interests: {', '.join(candidate.interests) or 'unclear'}")
        lines.append(f"- evidence: {', '.join(candidate.evidence_urls) or 'none'}")
        for reason in candidate.why:
            lines.append(f"- {reason}")
        lines.append("")
        lines.append("Reply here (public thread only):")
        lines.append("")
        lines.append("```")
        lines.append(candidate.draft)
        lines.append("```")
        lines.append("")

    if not candidates:
        lines += [
            "Nothing cleared the bar this run. That is a normal result: two public items",
            "in one thread from the last 45 days is a deliberately high minimum before a",
            "stranger is worth interrupting.",
            "",
        ]

    return "\n".join(lines)


def write_outputs(
    out_dir: Path,
    candidates: list[Candidate],
    stats: dict[str, int],
    reports: list[dict[str, str]],
    topics: list[str],
    generated_at: str,
) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    queue_path = out_dir / "queue.json"
    digest_path = out_dir / "digest.md"
    report_path = out_dir / "report.json"

    queue_path.write_text(
        json.dumps(
            {
                "generated_at": generated_at,
                "topics": topics,
                "policy": policy.policy_summary(),
                "stats": stats,
                "candidates": [candidate.to_json() for candidate in candidates],
            },
            indent=2,
        )
        + "\n"
    )
    digest_path.write_text(render_digest(candidates, stats, reports, topics, generated_at) + "\n")
    report_path.write_text(
        json.dumps({"generated_at": generated_at, "sources": reports, "stats": stats}, indent=2) + "\n"
    )
    return {"queue": queue_path, "digest": digest_path, "report": report_path}
