"""Tandem's matching engine.

Design commitments, in order of importance:

1. **Explainable.** Every score decomposes into named factors, each with a
   weight you can read. There is no embedding blob that a user cannot audit.
2. **Reciprocal.** A match requires both people to want something the other can
   give. One-sided desire is capped at :data:`ONEWAY_CAP` and labelled a blocker.
3. **Consent-gated.** An unverified or unlisted profile cannot outrank a verified
   one, and neither is returned to a caller who fails the gate in ``gates.py``.
4. **Deterministic.** Same two profiles in, same number out. No randomness, no
   clock-dependent scoring except timezone *offset*, never "now" as a signal.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping

from . import vocab

ENGINE_VERSION = vocab.ENGINE_VERSION

#: Factor weights. Must sum to 1.0 — asserted at import time.
WEIGHTS: dict[str, float] = {
    "goal": 0.30,
    "interest": 0.25,
    "availability": 0.15,
    "communication": 0.12,
    "timezone": 0.10,
    "momentum": 0.08,
}

assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9, "factor weights must sum to 1.0"

#: A score with no goal overlap is not a match, whatever else lines up.
ONEWAY_CAP = 0.22
#: Unverified identity keeps a profile below any verified match.
UNVERIFIED_CAP = 0.35
#: Below this, we do not show the pair at all.
DISPLAY_FLOOR = 0.30


@dataclass
class Profile:
    """A normalized matching view of one person."""

    id: str
    display_name: str = ""
    timezone: str | None = None
    interests: set[str] = field(default_factory=set)
    observed_interests: set[str] = field(default_factory=set)
    project_tags: set[str] = field(default_factory=set)
    looking_for: set[str] = field(default_factory=set)
    offers: set[str] = field(default_factory=set)
    hours_per_week: int = 0
    has_project: bool = False
    pace: str = "mixed"
    directness: int = 3
    group_size: str = "small"
    channels: set[str] = field(default_factory=set)
    verified: bool = False
    visibility: str = "searchable"
    raw: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> "Profile":
        comm = data.get("comm_style") or {}
        if not isinstance(comm, Mapping):
            comm = {}

        roles = {r for r in (vocab.clean_role(x) for x in _as_list(data.get("looking_for"))) if r}
        offers = {r for r in (vocab.clean_role(x) for x in _as_list(data.get("offers"))) if r}

        pace = vocab.normalize_tag(comm.get("pace")) or "mixed"
        if pace not in vocab.PACE:
            pace = "mixed"
        group = vocab.normalize_tag(comm.get("group_size")) or "small"
        if group not in vocab.GROUP_SIZE:
            group = "small"
        try:
            directness = int(comm.get("directness", 3))
        except (TypeError, ValueError):
            directness = 3
        directness = max(1, min(5, directness))

        channels = {
            vocab.normalize_tag(c).replace("-", "_")
            for c in _as_list(comm.get("prefers"))
        }
        channels &= set(vocab.CHANNELS)

        project = data.get("current_project") or ""
        return cls(
            id=str(data.get("id") or ""),
            display_name=str(data.get("display_name") or ""),
            timezone=_tz_name(data),
            interests=vocab.canonical_set(_as_list(data.get("interests"))),
            observed_interests=vocab.canonical_set(_as_list(data.get("observed_interests"))),
            project_tags=vocab.canonical_set(_as_list(data.get("project_tags"))),
            looking_for=roles,
            offers=offers,
            hours_per_week=_clamp_int(data.get("hours_per_week"), 0, 80),
            has_project=bool(isinstance(project, str) and project.strip()),
            pace=pace,
            directness=directness,
            group_size=group,
            channels=channels,
            verified=bool(data.get("verified")),
            visibility=str(data.get("visibility") or "searchable"),
            raw=dict(data),
        )


@dataclass
class Score:
    """One pair's result, fully decomposed."""

    score: float
    factors: dict[str, float]
    weights: dict[str, float]
    reasons: list[str]
    blockers: list[str]

    def to_json(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "breakdown": {
                name: {
                    "value": round(self.factors[name], 4),
                    "weight": self.weights[name],
                    "contribution": round(self.factors[name] * self.weights[name], 4),
                }
                for name in self.weights
            },
            "reasons": self.reasons,
            "blockers": self.blockers,
            "engine_version": ENGINE_VERSION,
        }


# --------------------------------------------------------------- helpers ----

def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part for part in value.replace(";", ",").split(",") if part.strip()]
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return []


def _clamp_int(value: Any, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(low, min(high, number))


def _tz_name(data: Mapping[str, Any]) -> str | None:
    tz = data.get("timezone")
    if isinstance(tz, str) and tz.strip():
        return tz.strip()
    location = data.get("location")
    if isinstance(location, Mapping):
        inner = location.get("timezone")
        if isinstance(inner, str) and inner.strip():
            return inner.strip()
    return None


_OFFSET_FALLBACK = {
    "UTC": 0,
    "America/New_York": -5, "America/Chicago": -6, "America/Denver": -7,
    "America/Los_Angeles": -8, "America/Sao_Paulo": -3, "Europe/London": 0,
    "Europe/Berlin": 1, "Europe/Paris": 1, "Europe/Warsaw": 1, "Europe/Kyiv": 2,
    "Asia/Kolkata": 5.5, "Asia/Tokyo": 9, "Asia/Shanghai": 8,
    "Asia/Singapore": 8, "Australia/Sydney": 10,
}


def utc_offset_hours(tz_name: str | None) -> float | None:
    """Current UTC offset for an IANA zone, with a small static fallback."""
    if not tz_name:
        return None
    try:
        from zoneinfo import ZoneInfo

        zone = ZoneInfo(tz_name)
        delta = datetime.now(timezone.utc).astimezone(zone).utcoffset()
        if delta is not None:
            return delta.total_seconds() / 3600.0
    except Exception:
        pass
    return _OFFSET_FALLBACK.get(tz_name)


def _jaccard(a: Iterable[str], b: Iterable[str]) -> float:
    left, right = set(a), set(b)
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


# --------------------------------------------------------------- factors ----

def goal_factor(a: Profile, b: Profile) -> tuple[float, list[str], list[str]]:
    """Do these two want something the other can provide?"""
    reasons: list[str] = []
    blockers: list[str] = []

    # Reciprocity needs a stated goal on both sides. If one person hasn't said
    # what they want, we refuse to guess: the pair scores zero rather than
    # scoring on whatever role the other person happens to offer.
    if not a.looking_for or not b.looking_for:
        return 0.0, [], ["One of you has not said what you are looking for"]

    peer_best, peer_pair = 0.0, None
    for x in a.looking_for:
        for y in b.looking_for:
            key = (x, y) if (x, y) in vocab.PEER else (y, x)
            value = vocab.PEER.get(key, 0.0)
            if value > peer_best:
                peer_best, peer_pair = value, (x, y)

    fill_ab, fill_ab_pair = 0.0, None
    for want in a.looking_for:
        for gave in b.offers:
            value = vocab.FILL.get((want, gave), 0.0)
            if value > fill_ab:
                fill_ab, fill_ab_pair = value, (want, gave)

    fill_ba, fill_ba_pair = 0.0, None
    for want in b.looking_for:
        for gave in a.offers:
            value = vocab.FILL.get((want, gave), 0.0)
            if value > fill_ba:
                fill_ba, fill_ba_pair = value, (want, gave)

    best = max(peer_best, fill_ab, fill_ba)

    if peer_best >= best and peer_pair and set(peer_pair) == {"mentor", "mentee"}:
        reasons.append("One wants a mentor, the other wants to mentor")
    elif peer_best >= best and peer_pair:
        reasons.append(f"Both are looking for {_role_label(peer_pair[0])}")
    elif fill_ab >= best and fill_ab_pair:
        reasons.append(
            f"You want {_role_label(fill_ab_pair[0])} and they offer it"
        )
    elif fill_ba_pair:
        reasons.append(
            f"They want {_role_label(fill_ba_pair[0])} and you offer it"
        )

    if best >= 0.999 and peer_best < 0.999 and fill_ab >= 0.999 and fill_ba >= 0.999:
        reasons.append("The pairing is mutual in both directions")

    if best == 0.0:
        blockers.append("No goal in common")

    return best, reasons, blockers


def interest_factor(a: Profile, b: Profile) -> tuple[float, list[str], list[str]]:
    shared = sorted(a.interests & b.interests)
    jaccard = _jaccard(a.interests, b.interests)
    project_overlap = _jaccard(a.project_tags, b.project_tags)

    # Declared interests dominate. Observed interests (derived from handles the
    # person linked themselves) contribute only when both sides have them, so
    # nobody is penalised for not linking an account.
    observed_shared = sorted(
        (a.observed_interests & b.observed_interests) - (a.interests | b.interests)
    )
    both_observed = bool(a.observed_interests and b.observed_interests)
    observed_jaccard = _jaccard(a.observed_interests, b.observed_interests) if both_observed else 0.0
    tag_jaccard = 0.85 * jaccard + 0.15 * observed_jaccard if both_observed else jaccard

    score = 0.80 * tag_jaccard + 0.20 * project_overlap
    reasons: list[str] = []
    blockers: list[str] = []

    if shared:
        shown = ", ".join(shared[:4])
        more = "" if len(shared) <= 4 else f" +{len(shared) - 4} more"
        reasons.append(f"Shares {len(shared)} interest{'s' if len(shared) > 1 else ''}: {shown}{more}")
    elif a.interests and b.interests:
        blockers.append("No shared interests")

    if observed_shared:
        shown = ", ".join(observed_shared[:3])
        reasons.append(f"Also writes about {shown}, from handles you both declared")

    if project_overlap:
        overlap = ", ".join(sorted(a.project_tags & b.project_tags)[:3])
        reasons.append(f"Working in the same area right now: {overlap}")

    # a small floor so a single strong shared interest isn't punished for being narrow
    if shared and score < 0.18:
        score = 0.18

    return min(1.0, score), reasons, blockers


def availability_factor(a: Profile, b: Profile) -> tuple[float, list[str], list[str]]:
    reasons: list[str] = []
    blockers: list[str] = []
    left, right = a.hours_per_week, b.hours_per_week

    if left == 0 or right == 0:
        blockers.append("One of you has not shared weekly availability")
        return 0.35, reasons, blockers

    low, high = sorted((left, right))
    ratio = low / high
    score = 0.40 + 0.60 * ratio

    if ratio >= 0.6:
        reasons.append(f"Similar time to give ({left}h and {right}h per week)")
    elif ratio <= 0.25:
        blockers.append(f"Availability mismatch ({left}h vs {right}h per week)")

    return min(1.0, score), reasons, blockers


def communication_factor(a: Profile, b: Profile) -> tuple[float, list[str], list[str]]:
    reasons: list[str] = []
    blockers: list[str] = []

    if a.pace == b.pace:
        pace = 1.0
        reasons.append(f"Both prefer {a.pace} conversation")
    elif "mixed" in (a.pace, b.pace):
        pace = 0.65
    else:
        pace = 0.25
        blockers.append(f"Rhythm clash: {a.pace} vs {b.pace}")

    directness = 1.0 - abs(a.directness - b.directness) / 4.0

    if a.group_size == b.group_size:
        group = 1.0
        reasons.append(f"Same group preference ({a.group_size.replace('_', ' ')})")
    else:
        order = {name: i for i, name in enumerate(vocab.GROUP_SIZE)}
        group = 0.60 if abs(order[a.group_size] - order[b.group_size]) == 1 else 0.25

    if a.channels and b.channels:
        channel = _jaccard(a.channels, b.channels)
        shared = sorted(a.channels & b.channels)
        if shared:
            reasons.append(f"Same channels ({', '.join(shared)})")
    else:
        channel = 0.50

    score = 0.35 * pace + 0.20 * directness + 0.20 * group + 0.25 * channel
    return min(1.0, score), reasons, blockers


def timezone_factor(a: Profile, b: Profile) -> tuple[float, list[str], list[str]]:
    off_a, off_b = utc_offset_hours(a.timezone), utc_offset_hours(b.timezone)
    if off_a is None or off_b is None:
        return 0.50, ["Timezone unknown, treated as neutral"], []

    gap = abs(off_a - off_b)
    if gap > 12:  # wrapped the other way round the planet
        gap = 24 - gap

    if gap <= 2:
        return 1.00, [f"Same working hours (about {gap:g}h apart)"], []
    if gap <= 4:
        return 0.85, [f"Overlapping working hours ({gap:g}h apart)"], []
    if gap <= 6:
        return 0.60, [], [f"{gap:g}h apart, overlap is thin"]
    if gap <= 9:
        return 0.35, [], [f"{gap:g}h apart"]
    return 0.15, [], [f"{gap:g}h apart, almost no overlap"]


def momentum_factor(a: Profile, b: Profile) -> tuple[float, list[str], list[str]]:
    reasons: list[str] = []
    both = a.has_project and b.has_project
    if both:
        reasons.append("Both have something actively on the bench")
    tags = a.project_tags & b.project_tags
    score = (0.5 if a.has_project else 0.1) + (0.5 if b.has_project else 0.1)
    if tags:
        score += 0.15
    return min(1.0, score), reasons, []


FACTORS = {
    "goal": goal_factor,
    "interest": interest_factor,
    "availability": availability_factor,
    "communication": communication_factor,
    "timezone": timezone_factor,
    "momentum": momentum_factor,
}

_ROLE_LABELS = {
    "cofounder": "a co-founder",
    "collaborator": "a project partner",
    "study_partner": "a study partner",
    "accountability": "an accountability partner",
    "mentor": "a mentor",
    "mentee": "someone to mentor",
    "hobby_group": "a hobby group",
    "friend": "a friend",
}


def _role_label(role: str) -> str:
    return _ROLE_LABELS.get(role, role.replace("_", " "))


# ----------------------------------------------------------------- public ----

def score_pair(a: Profile, b: Profile) -> Score:
    """Score one ordered pair. Result is symmetric unless caps differ."""
    factors: dict[str, float] = {}
    reasons: list[str] = []
    blockers: list[str] = []

    for name, fn in FACTORS.items():
        value, why, why_not = fn(a, b)
        factors[name] = value
        reasons.extend(why)
        blockers.extend(why_not)

    raw = sum(factors[name] * WEIGHTS[name] for name in WEIGHTS)

    if factors["goal"] == 0.0:
        raw = min(raw, ONEWAY_CAP)
    if not (a.verified and b.verified):
        raw = min(raw, UNVERIFIED_CAP)
        blockers.append("Identity not both verified")

    # dedupe while keeping order
    reasons = list(dict.fromkeys(reasons))
    blockers = list(dict.fromkeys(blockers))

    return Score(
        score=round(max(0.0, min(1.0, raw)), 3),
        factors=factors,
        weights=dict(WEIGHTS),
        reasons=reasons,
        blockers=blockers,
    )


def match(
    subject: Mapping[str, Any],
    candidates: Iterable[Mapping[str, Any]],
    limit: int = 10,
    include_unlisted: bool = False,
) -> dict[str, Any]:
    """Rank candidates for ``subject``. Returns a JSON-ready payload."""
    me = Profile.from_json(subject)
    scored: list[dict[str, Any]] = []

    for raw in candidates:
        other = Profile.from_json(raw)
        if not other.id or other.id == me.id:
            continue
        if other.visibility != "searchable" and not include_unlisted:
            continue

        result = score_pair(me, other)
        if result.score < DISPLAY_FLOOR:
            continue

        entry = {
            "person_id": other.id,
            "display_name": other.display_name,
            "score": result.score,
        }
        entry.update(result.to_json())
        scored.append(entry)

    scored.sort(key=lambda item: (-item["score"], item["person_id"]))
    return {
        "engine_version": ENGINE_VERSION,
        "vocab_version": vocab.VOCAB_VERSION,
        "person_id": me.id,
        "weights": dict(WEIGHTS),
        "requested_limit": limit,
        "matches": scored[: max(1, min(limit, 100))],
    }
