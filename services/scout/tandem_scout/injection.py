"""Text addressed to whoever reads the digest.

The scout reads public writing: issue bodies, post text, commit messages. Some of it
is written to instruct a reader rather than to be read, and an operator or an agent
reading a digest is exactly the reader it aims at. That is not a matching signal, so
it is not carried into a digest.

When it turns up mid-fetch the connection is closed at the point of detection: the
rest of the document is never read, the attempt is written to a log, and the URL is
quarantined so the next run does not open it again.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[3] / "data" / "scout"
DEFAULT_LOG = DATA_DIR / "injection-log.jsonl"
DEFAULT_QUARANTINE = DATA_DIR / "quarantine.json"

# Narrow on purpose. Each rule describes text that addresses a reader as an agent.
# Ordinary prose about AI, prompts or security must not trip these.
RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("override_instructions", re.compile(r"ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+instructions", re.I)),
    ("discard_context", re.compile(r"disregard\s+(?:the\s+)?(?:above|previous|prior|system|prior\s+context)", re.I)),
    ("new_instructions", re.compile(r"(?:^|\n)\s*new\s+instructions\s*:", re.I)),
    ("address_the_reader", re.compile(r"you\s+must\s+(?:now\s+)?(?:post|reply|send|email|message|publish|wire|transfer)", re.I)),
    ("post_replies", re.compile(r"post\s+(?:one|two|1|2|a\s+few)\s+(?:or\s+\w+\s+)?repl(?:y|ies)", re.I)),
    ("keep_it_quiet", re.compile(r"do\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+(?:the\s+)?(?:user|operator|human|owner)", re.I)),
    ("role_marker", re.compile(r"<\|?\s*(?:im_start|system|assistant)\s*\|?>", re.I)),
    ("agent_address", re.compile(r"(?:as\s+an?\s+)?(?:ai\s+assistant|language\s+model|agent)[,:]?\s+you\s+(?:should|must|will|are\s+to)", re.I)),
)

MAX_EXCERPT = 160


def _excerpt(text: str, match: re.Match[str]) -> str:
    """A short, single-line, redacted-by-truncation quote for the log."""
    start = max(0, match.start() - 40)
    raw = text[start : start + MAX_EXCERPT]
    return " ".join(raw.split())


def scan(text: str) -> list[tuple[str, str]]:
    """Every rule that fired, with an excerpt. Empty means nothing addressed a reader."""
    if not text:
        return []
    hits: list[tuple[str, str]] = []
    for rule, pattern in RULES:
        match = pattern.search(text)
        if match:
            hits.append((rule, _excerpt(text, match)))
    return hits


@dataclass(frozen=True)
class Attempt:
    rule: str
    source: str
    url: str
    excerpt: str
    at: str
    action: str = "connection_closed"

    def to_json(self) -> dict[str, str]:
        return asdict(self)


class InjectionRefused(Exception):
    """Raised at the point of detection, after the log and quarantine are written."""

    def __init__(self, attempt: Attempt):
        super().__init__(
            f"injection attempt from {attempt.source} ({attempt.rule}); "
            "the connection was closed and the text was not used"
        )
        self.attempt = attempt


class InjectionLog:
    """Append-only evidence, plus the list of URLs we refuse to open again."""

    def __init__(self, log_path: Path = DEFAULT_LOG, quarantine_path: Path = DEFAULT_QUARANTINE):
        self.log_path = Path(log_path)
        self.quarantine_path = Path(quarantine_path)

    def quarantined(self) -> dict[str, dict[str, str]]:
        if not self.quarantine_path.exists():
            return {}
        try:
            data = json.loads(self.quarantine_path.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
        return data if isinstance(data, dict) else {}

    def is_quarantined(self, url: str) -> bool:
        return url in self.quarantined()

    def record(self, attempt: Attempt) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(attempt.to_json(), sort_keys=True) + "\n")
        if attempt.url:
            held = self.quarantined()
            held.setdefault(
                attempt.url,
                {"first_seen": attempt.at, "source": attempt.source, "rule": attempt.rule},
            )
            self.quarantine_path.parent.mkdir(parents=True, exist_ok=True)
            self.quarantine_path.write_text(json.dumps(held, indent=2, sort_keys=True) + "\n")

    def guard(self, text: str, *, source: str, url: str) -> str:
        """Return the text, or log the attempt and raise InjectionRefused."""
        hits = scan(text)
        if not hits:
            return text
        rule, excerpt = hits[0]
        attempt = Attempt(
            rule=rule,
            source=source,
            url=url,
            excerpt=excerpt,
            at=datetime.now(timezone.utc).isoformat(),
        )
        self.record(attempt)
        raise InjectionRefused(attempt)


def quarantined_attempt(url: str, source: str = "") -> Attempt:
    """The refusal for a URL we already caught. Same log, no fetch."""
    host = source or url.split("//")[-1].split("/")[0]
    return Attempt(
        rule="quarantined",
        source=host,
        url=url,
        excerpt="",
        at=datetime.now(timezone.utc).isoformat(),
        action="refused_without_connecting",
    )


DEFAULT = InjectionLog()
