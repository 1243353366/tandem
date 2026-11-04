"""Turning public text into topic signals.

The point of this module is that it is *boring*. There is no model, no embedding,
no interest graph. It maps words onto the same closed vocabulary the matcher uses,
counts how often and how recently someone wrote about a topic in public, and
stops there.

A person is not a bag of tags. But "this public handle wrote about AI three times
in the last month" is a claim we can show evidence for, and that is the only kind
of claim the invite queue is allowed to make.
"""

from __future__ import annotations

import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone

# Reuse the matcher's vocabulary instead of growing a second taxonomy.
_MATCHER = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "matcher")
if _MATCHER not in sys.path:
    sys.path.insert(0, _MATCHER)

from tandem_matcher import vocab  # noqa: E402

KNOWN_GROUPS = frozenset(vocab.GROUPS)
_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9+#\-]{1,24}")

#: Multi-word interests that only make sense as a phrase.
PHRASES = (
    "machine learning",
    "open source",
    "threat intel",
    "reverse engineering",
    "data engineering",
    "product design",
    "board games",
    "side project",
    "self hosted",
    "distributed systems",
)


def extract_interests(text: str, max_tags: int = 6) -> list[str]:
    """Map free text onto canonical interest groups, most mentioned first."""
    lowered = (text or "").lower()
    counts: Counter[str] = Counter()

    for phrase in PHRASES:
        if phrase in lowered:
            tag = vocab.canonical_tag(phrase)
            if tag in KNOWN_GROUPS:
                counts[tag] += 3  # an explicit phrase is a stronger signal than a word

    for token in _TOKEN.findall(lowered):
        tag = vocab.canonical_tag(token)
        if tag in KNOWN_GROUPS:
            counts[tag] += 1

    return [tag for tag, _ in counts.most_common(max_tags)]


def interest_match(interests: list[str], topics: list[str]) -> float:
    """How much of what we asked for this person actually talks about."""
    if not topics:
        return 0.0
    wanted = {vocab.canonical_tag(topic) for topic in topics}
    wanted = {tag for tag in wanted if tag}
    if not wanted:
        return 0.0
    hit = len(wanted & set(interests))
    return hit / len(wanted)


def activity_score(ages_days: list[float]) -> float:
    """Recency-weighted posting volume, squashed into 0..1.

    Three posts in the last week beats thirty posts from last year, because the
    question is "is this person around right now", not "were they once prolific".
    """
    if not ages_days:
        return 0.0
    weighted = 0.0
    for age in ages_days:
        if age <= 7:
            weighted += 1.0
        elif age <= 30:
            weighted += 0.6
        elif age <= 90:
            weighted += 0.25
        else:
            weighted += 0.05
    # 4 recent posts is a clear signal; more than that adds little.
    return min(1.0, weighted / 4.0)


def breadth_score(threads: int) -> float:
    """Writing in several threads is better evidence than one long argument."""
    return min(1.0, max(0, threads) / 3.0)


def priority(interest: float, activity: float, breadth: float) -> float:
    """One number, three explainable parts. Weights are published, not tuned by vibes."""
    return round(0.55 * interest + 0.30 * activity + 0.15 * breadth, 4)


def describe(
    source: str,
    interests: list[str],
    observations: int,
    threads: int,
    last_seen: str,
    now: datetime | None = None,
) -> list[str]:
    """Plain-language reasons, in the same spirit as the matcher's reasons."""
    now = now or datetime.now(timezone.utc)
    reasons: list[str] = []

    if interests:
        reasons.append(f"Writes about {', '.join(interests[:3])} in public")
    if observations:
        reasons.append(f"{observations} public item{'s' if observations != 1 else ''} on {source}")

    try:
        seen = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        days = max(0, (now - seen).days)
        if days <= 7:
            reasons.append("Active this week")
        elif days <= 30:
            reasons.append(f"Active {days} days ago")
        else:
            reasons.append(f"Last seen {days} days ago")
    except ValueError:
        pass

    if threads > 1:
        reasons.append(f"Shows up in {threads} different threads")

    return reasons
