"""The rules the scout is not allowed to break.

This file is the reason the scout is defensible, so it is written as
prohibitions rather than features. Every one of them is enforced by a function
here and pinned by a test in `test/test_scout.py`. If you fork Tandem and delete
this module, you are building a different, worse product.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

#: Channels an invitation may ever be delivered through.
#: `public_thread` = reply in the same public thread where the signal was seen.
#: There is no DM, no email, no SMS. Not "not yet": never.
ALLOWED_INVITE_CHANNELS = ("public_thread",)

#: Signal sources we read, and the only ones we read.
ALLOWED_SOURCES = ("hackernews", "devto", "github", "bluesky", "telegram_public", "reddit")

#: How visible a surface has to be before we will read it.
#:
#:   public_surface  an open read endpoint anyone could call from a browser
#:   public_group    a group or channel that publishes its own join link and
#:                   reads without joining; the group is the actor, not a person
#:   private         members-only, invite-only, paid, or a DM. Never read.
#:
#: The line is not "public vs private internet". It is: **did the people posting
#: choose a space where strangers can read it without being admitted?**
SURFACE_VISIBILITY = {
    "hackernews": "public_surface",
    "devto": "public_surface",
    "github": "public_surface",
    "bluesky": "public_surface",
    "telegram_public": "public_group",
    "reddit": "public_group",
    "discord": "public_group",
    "facebook": "public_group",
}

ALLOWED_SURFACES = ("public_surface", "public_group")

#: Surfaces that are categorically refused, whatever the operator wants.
PRIVATE_SURFACES = (
    "direct_message",
    "private_channel",
    "members_only",
    "invite_only",      # an invite we were given, not one published to the world
    "paid",
    "closed_group",
    "group_member_list",
)

#: Sources whose observations describe a *group*, not an individual. They feed
#: the community list. They can never produce an invitation, because you cannot
#: invite a channel and you must not treat a channel's audience as a lead list.
GROUP_SOURCES = ("telegram_public", "reddit", "discord", "facebook")

#: What a group must satisfy before we will read it. All four, no exceptions.
GROUP_ADMISSION_RULES = (
    "the join link is published by the group itself, in public, without an approval step",
    "the content is readable without joining (a public preview or open page)",
    "we read posts only, never the member list, join requests, or reactions",
    "we never enumerate members, and never try to resolve a poster's identity",
)

#: Sources we implement but deliberately leave off by default, with the reason
#: spelled out so a fork has to make an informed choice.
DISABLED_SOURCES = {
    "reddit": (
        "reddit's unauthenticated JSON endpoints return 403 to non-browser clients, "
        "and doing this at scale requires an OAuth app plus API terms acceptance. "
        "Enable it only if you have done that: TANDEM_SCOUT_ENABLE=reddit"
    ),
}

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
#: Candidate runs of digits and separators. Length is checked separately, because
#: a fixed-width pattern cannot express "+1 (415) 555-0134" without also matching
#: timestamps and version strings.
PHONE_CANDIDATE = re.compile(r"\+?\d[\d\s().\-]{7,}\d")
#: Handles that look like a personal identifier rather than a public account name.
SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")

#: Hard ceilings. Small numbers on purpose: this is a human-scale invitation
#: process, not a growth funnel.
MAX_INVITES_PER_RUN = 25
MAX_INVITES_PER_HANDLE = 1
MAX_OBSERVATIONS_PER_HANDLE = 40
MAX_QUEUE_SIZE = 200

#: Minimum evidence before a handle is worth a human's attention.
MIN_OBSERVATIONS = 2
MIN_THREADS = 1
MAX_AGE_DAYS = 45


class PolicyViolation(RuntimeError):
    """Raised when something tries to do what the scout is not allowed to do."""


def _redact_phones(text: str) -> tuple[str, int]:
    """Redact runs that carry enough digits to be a phone number."""

    def replace(match: re.Match[str]) -> str:
        run = match.group(0)
        digits = sum(character.isdigit() for character in run)
        international = run.startswith("+")
        if digits >= (9 if international else 10):
            return "[redacted]"
        return run

    return PHONE_CANDIDATE.subn(replace, text)


def scrub_pii(text: str) -> tuple[str, bool]:
    """Strip contact details from an observation.

    Returns (cleaned_text, was_scrubbed). We keep the observation (the topic
    signal is still real) but remove the identifier, because regex-matching other
    people's phone numbers into a local file is exactly the failure mode this
    project exists to avoid.
    """
    cleaned = text or ""
    found = False
    for pattern in (EMAIL_RE, SSN_RE):
        cleaned, count = pattern.subn("[redacted]", cleaned)
        if count:
            found = True
    cleaned, phone_count = _redact_phones(cleaned)
    if phone_count:
        found = True
    return cleaned, found


def surface_of(source: str) -> str:
    """The visibility class of a source, or a refusal."""
    kind = SURFACE_VISIBILITY.get(source)
    if kind is None:
        raise PolicyViolation(f"source {source!r} has no declared visibility")
    if kind not in ALLOWED_SURFACES:
        raise PolicyViolation(
            f"source {source!r} is {kind!r}; only {', '.join(ALLOWED_SURFACES)} may be read"
        )
    return kind


def assert_surface(kind: str) -> None:
    """Refuse a private surface by name, so the refusal is testable."""
    if kind in PRIVATE_SURFACES:
        raise PolicyViolation(
            f"{kind!r} is a private surface. Tandem reads public groups, not private ones: "
            "the people in a members-only space did not choose to be readable."
        )
    if kind not in ALLOWED_SURFACES:
        raise PolicyViolation(f"unknown surface {kind!r}")


def assert_group_admitted(join_url: str, readable_without_joining: bool, member_scrape: bool = False) -> None:
    """A public group is admissible only if it published its own way in."""
    if member_scrape:
        raise PolicyViolation(
            "member lists, join requests, and reactions are never read; "
            "a group's audience is not a lead list"
        )
    if not readable_without_joining:
        raise PolicyViolation(
            "this group's content is not readable without joining, so it is not a public group"
        )
    if not join_url or not join_url.startswith(("https://", "http://")):
        raise PolicyViolation(
            "a public group must publish its own public join link; "
            "an invitation given to us privately is not a public group"
        )


def produces_individuals(source: str) -> bool:
    """Whether an observation from this source can lead to a personal invite."""
    return source not in GROUP_SOURCES


def assert_invite_channel(channel: str) -> None:
    if channel not in ALLOWED_INVITE_CHANNELS:
        raise PolicyViolation(
            f"invite channel {channel!r} is not permitted; "
            f"allowed: {', '.join(ALLOWED_INVITE_CHANNELS)}"
        )


def assert_source(source: str) -> None:
    if source not in ALLOWED_SOURCES:
        raise PolicyViolation(f"source {source!r} is not in the allow list")


def load_optouts(path: Path | None) -> set[str]:
    """Handles that asked not to be contacted, as `source:handle` and bare handle."""
    if not path or not path.exists():
        return set()
    out: set[str] = set()
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip().lower()
        if line:
            out.add(line)
    return out


def is_opted_out(handle: str, source: str, optouts: Iterable[str]) -> bool:
    optouts = set(optouts)
    return handle.lower() in optouts or f"{source}:{handle}".lower() in optouts


def invites_allowed(already_invited: int, cap: int = MAX_INVITES_PER_RUN) -> int:
    """How many more invitations this run may queue."""
    return max(0, min(cap, MAX_INVITES_PER_RUN) - already_invited)


def policy_summary() -> dict[str, object]:
    return {
        "allowed_sources": list(ALLOWED_SOURCES),
        "surfaces": {
            "reads": list(ALLOWED_SURFACES),
            "reads_note": "public groups yes, private groups no",
            "never_reads": list(PRIVATE_SURFACES),
            "group_admission": list(GROUP_ADMISSION_RULES),
        },
        "group_sources": list(GROUP_SOURCES),
        "group_sources_note": (
            "observations from a group describe the group, not a person; they feed the "
            "community list and can never produce an invitation"
        ),
        "disabled_sources": DISABLED_SOURCES,
        "allowed_invite_channels": list(ALLOWED_INVITE_CHANNELS),
        "reads": "public read endpoints only; no login, no scraping behind auth",
        "collects": "public handle, public text, public permalink, timestamp",
        "never_collects": [
            "phone numbers",
            "email addresses",
            "home or work location",
            "cross-platform identity links",
            "anything behind a login",
        ],
        "caps": {
            "invites_per_run": MAX_INVITES_PER_RUN,
            "invites_per_handle": MAX_INVITES_PER_HANDLE,
            "queue_size": MAX_QUEUE_SIZE,
        },
        "minimum_evidence": {
            "observations": MIN_OBSERVATIONS,
            "threads": MIN_THREADS,
            "recency_days": MAX_AGE_DAYS,
        },
    }
