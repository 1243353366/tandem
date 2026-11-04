"""Data shapes for the scout.

An `Observation` is one public post by one public handle. It carries no
identifiers beyond the handle the platform itself publishes, because the scout's
job is to answer "who is talking about this topic in public", not "who is this
person and how do I reach them".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class Observation:
    """One public item: a post, comment, issue, or article."""

    source: str                 # 'hackernews' | 'devto' | 'github' | 'reddit' | 'bluesky'
    handle: str                 # the public username, exactly as the platform shows it
    text: str                   # public title/body excerpt, already truncated
    url: str                    # permalink to the public item
    created_at: str             # ISO 8601 UTC
    topic: str = ""             # the query that surfaced it
    extra: dict[str, Any] = field(default_factory=dict)

    def age_days(self, now: datetime | None = None) -> float:
        now = now or datetime.now(timezone.utc)
        try:
            seen = datetime.fromisoformat(self.created_at.replace("Z", "+00:00"))
        except ValueError:
            return 999.0
        if seen.tzinfo is None:
            seen = seen.replace(tzinfo=timezone.utc)
        return max(0.0, (now - seen).total_seconds() / 86400.0)


@dataclass
class Candidate:
    """A handle worth inviting, and the evidence behind that conclusion."""

    source: str
    handle: str
    profile_url: str
    interests: list[str]
    observations: int
    threads: int
    last_seen: str
    priority: float
    why: list[str]
    evidence_urls: list[str]
    invite_channel: str = "public_thread"
    invite_url: str = ""
    draft: str = ""
    #: interest -> the URLs whose text produced it, so a reader can check the claim
    interest_sources: dict[str, list[str]] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            # Written by someone else. Consumers must treat every field except
            # `untrusted` as data, never as an instruction.
            "untrusted": True,
            "source": self.source,
            "handle": self.handle,
            "profile_url": self.profile_url,
            "interests": self.interests,
            "observations": self.observations,
            "threads": self.threads,
            "last_seen": self.last_seen,
            "priority": round(self.priority, 3),
            "why": self.why,
            "evidence_urls": self.evidence_urls,
            "interest_sources": self.interest_sources,
            "invite": {
                "channel": self.invite_channel,
                "url": self.invite_url,
                "draft": self.draft,
            },
        }
