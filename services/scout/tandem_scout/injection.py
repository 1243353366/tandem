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
import os
import re
import unicodedata
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

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
C0_C1 = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def visible(text: str) -> str:
    """Text with anything that acts on a terminal or a renderer removed.

    Escape sequences, C0/C1 controls and Unicode format characters (zero-width
    joiners, bidi overrides) have no meaning as content and plenty as decoration: a
    log line containing them can repaint the console that prints it.
    """
    text = ANSI.sub("", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    text = C0_C1.sub(" ", text)
    return " ".join(text.split())


def normalize_for_scan(text: str) -> str:
    """Fold the cheap obfuscations before matching.

    NFKC collapses fullwidth and compatibility forms; dropping Cf removes the
    zero-width characters people insert between letters of a word to defeat a
    pattern match; collapsing whitespace removes the same trick with padding.
    """
    text = unicodedata.normalize("NFKC", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    return " ".join(text.split())


def _excerpt(text: str, match: re.Match[str]) -> str:
    """A short, single-line, terminal-safe quote for the log."""
    start = max(0, match.start() - 40)
    return visible(text[start : start + MAX_EXCERPT])


def scan(text: str) -> list[tuple[str, str]]:
    """Every rule that fired, with an excerpt. Empty means nothing addressed a reader."""
    if not text:
        return []
    text = normalize_for_scan(text)
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
    final_url: str = ""   # after redirects: what we actually read
    key: str = ""         # what gets quarantined; a URL, or source:handle

    def quarantine_key(self) -> str:
        return self.key or self.url or f"src:{self.source}"

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


#: Attempts are evidence, so they are never truncated. The file is rotated instead, one
#: generation kept, because an attacker who can generate attempts can also fill a disk.
LOG_MAX_BYTES = 5 * 1024 * 1024


class InjectionLog:
    """Append-only evidence, plus the list of URLs we refuse to open again."""

    def __init__(self, log_path: Path = DEFAULT_LOG, quarantine_path: Path = DEFAULT_QUARANTINE):
        self.log_path = Path(log_path)
        self.quarantine_path = Path(quarantine_path)

    def _rotate(self) -> None:
        """Keep one previous generation once the log passes its ceiling.

        A size cap has to drop something, and what it drops is the oldest attempt. That is the
        trade: unbounded evidence, or a disk an attacker can fill. Rotation itself is worth an
        alert, because a burst that forces it is more interesting than any single line in it.

        Best effort under concurrency: two scouts may both rotate, and the loser's rename fails
        harmlessly.
        """
        try:
            if self.log_path.exists() and self.log_path.stat().st_size >= LOG_MAX_BYTES:
                os.replace(self.log_path, self.log_path.with_name(self.log_path.name + ".1"))
        except OSError:
            return

    def _from_log(self) -> dict[str, dict[str, str]]:
        """Rebuild the hold list from the append-only log.

        The log is the evidence and the cache is a convenience, so a damaged cache
        cannot silently un-quarantine anything: it is rebuilt from the log instead of
        being read as empty.
        """
        held: dict[str, dict[str, str]] = {}
        if not self.log_path.exists():
            return held
        for line in self.log_path.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = str(event.get("key") or event.get("url") or "")
            if key:
                held.setdefault(key, {
                    "first_seen": str(event.get("at", "")),
                    "source": str(event.get("source", "")),
                    "rule": str(event.get("rule", "")),
                })
        return held

    def quarantined(self) -> dict[str, dict[str, str]]:
        held = self._from_log()
        if self.quarantine_path.exists():
            try:
                cached = json.loads(self.quarantine_path.read_text())
            except (json.JSONDecodeError, OSError):
                cached = {}
            if isinstance(cached, dict):
                for key, value in cached.items():
                    held.setdefault(key, value if isinstance(value, dict) else {})
        return held

    def is_quarantined(self, key: str) -> bool:
        return key in self.quarantined()

    def record(self, attempt: Attempt) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(attempt.to_json(), sort_keys=True) + "\n"
        # One O_APPEND write per attempt: two scouts racing cannot interleave halves of
        # a line, and nothing rewrites history already written.
        self._rotate()
        handle = os.open(self.log_path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.write(handle, line.encode("utf-8"))
            os.fsync(handle)
        finally:
            os.close(handle)

        held = self.quarantined()
        held.setdefault(
            attempt.quarantine_key(),
            {"first_seen": attempt.at, "source": attempt.source, "rule": attempt.rule},
        )
        self.quarantine_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.quarantine_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(held, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, self.quarantine_path)   # atomic: a reader sees old or new, never half

    def guard(self, text: str, *, source: str, url: str, handle: str = "",
              final_url: str = "", declared_at: str | None = None) -> str:
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
            at=declared_at or datetime.now(timezone.utc).isoformat(),
            final_url=final_url,
            key=url or (f"src:{source}:{handle}" if handle else ""),
        )
        self.record(attempt)
        raise InjectionRefused(attempt)


def too_large_attempt(url: str, source: str = "", limit: int = 0) -> Attempt:
    """A body past the cap is refused, not silently trimmed."""
    return Attempt(
        rule="body_cap_exceeded",
        source=source or url.split("//")[-1].split("/")[0],
        url=url,
        excerpt=f"body exceeded {limit} bytes; refused rather than truncated",
        at=datetime.now(timezone.utc).isoformat(),
        action="refused_oversized",
        key=url,
    )


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
