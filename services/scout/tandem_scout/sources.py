"""Public-source adapters.

Every adapter here reads a *public* endpoint that any browser could read, for a
search term. None of them authenticate as a person, page behind a login, or walk
a social graph. That is the entire discovery budget.

Two deliberate omissions:

  - Reddit is implemented but off by default. Its unauthenticated JSON endpoints
    return 403 to non-browser clients; doing this properly needs an OAuth app and
    an API terms acceptance. Forks can opt in; we do not pretend it is free.
  - Discord and Facebook are absent. Neither exposes topic search across public
    servers/groups to a third party. Any tool claiming otherwise is scraping
    against terms, and a "scan" of those surfaces is not something this project
    will ship.

Live mode also stores nothing about who you are, and sends no shared token.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .models import Observation
from . import injection, policy

USER_AGENT = "tandem-scout/0.1 (+https://github.com) public-signal discovery"

#: Callable that returns parsed JSON for a URL. Injected so tests never touch
#: the network and so a fork can plug in its own caching proxy.
HttpGet = Callable[[str], Any]
#: Callable that returns raw text for a URL, for the surfaces that serve HTML.
TextGet = Callable[[str], str]


@dataclass
class SourceReport:
    source: str
    status: str            # 'ok' | 'disabled' | 'error' | 'empty'
    observations: int = 0
    note: str = ""


CHUNK = 16 * 1024
BODY_CAP = 512 * 1024


def _addresses_reader(observation, log: injection.InjectionLog) -> bool:
    """True when a fetched item was addressed to the reader, not about the topic.

    Fetch-time detection covers the wire; this covers text that arrived inside a JSON
    field, where the poison is in a value rather than in the body we streamed.
    """
    try:
        log.guard(observation.text or "", source=observation.source, url=observation.url or "")
    except injection.InjectionRefused:
        return True
    return False


def _read_guarded(response, url: str, log: injection.InjectionLog) -> str:
    """Read the body in chunks, and stop the moment it addresses a reader.

    Scanning as we read is the difference between noticing and closing: by the time a
    whole body has been read and stored, the connection has done its job.
    """
    buffer = ""
    while True:
        block = response.read(CHUNK)
        if not block:
            return buffer
        buffer += block.decode("utf-8", "replace")
        if injection.scan(buffer):
            response.close()
            log.guard(buffer, source=url.split("//")[-1].split("/")[0], url=url)
        if len(buffer) >= BODY_CAP:
            return buffer[:BODY_CAP]


def _open(url: str, log: injection.InjectionLog, headers: dict[str, str], timeout: float):
    if log.is_quarantined(url):
        raise injection.InjectionRefused(injection.quarantined_attempt(url))
    request = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(request, timeout=timeout)


def default_http_get(url: str, timeout: float = 12.0, log: injection.InjectionLog | None = None) -> Any:
    log = log or injection.DEFAULT
    with _open(url, log, {"User-Agent": USER_AGENT, "Accept": "application/json"}, timeout) as response:
        return json.loads(_read_guarded(response, url, log))


def default_text_get(url: str, timeout: float = 12.0, log: injection.InjectionLog | None = None) -> str:
    log = log or injection.DEFAULT
    with _open(url, log, {"User-Agent": USER_AGENT}, timeout) as response:
        return _read_guarded(response, url, log)


def _iso(value: str | int | None) -> str:
    """Normalize the various timestamp shapes these APIs use."""
    if value is None:
        return datetime.now(timezone.utc).isoformat()
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    text = str(value)
    if text.endswith("Z"):
        return text
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc).isoformat()
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def _excerpt(text: str, limit: int = 400) -> str:
    clean = " ".join((text or "").split())
    return clean[:limit]


# --------------------------------------------------------------- adapters ----

class HackerNewsSource:
    """Hacker News via the Algolia search API. Public, documented, generous."""

    name = "hackernews"

    def fetch(self, topic: str, limit: int, http: HttpGet) -> list[Observation]:
        query = urllib.parse.urlencode({
            "query": topic,
            "tags": "(story,comment)",
            "hitsPerPage": str(min(limit, 50)),
        })
        payload = http(f"https://hn.algolia.com/api/v1/search?{query}")
        out: list[Observation] = []
        for hit in payload.get("hits", []):
            handle = hit.get("author")
            if not handle:
                continue
            story_id = hit.get("story_id") or hit.get("objectID")
            text = hit.get("title") or hit.get("comment_text") or ""
            out.append(
                Observation(
                    source=self.name,
                    handle=handle,
                    text=_excerpt(_strip_tags(text)),
                    url=f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
                    created_at=_iso(hit.get("created_at") or hit.get("created_at_i")),
                    topic=topic,
                    extra={"thread": f"hn:{story_id or hit.get('objectID')}"},
                )
            )
        return out


class DevToSource:
    """DEV Community articles by tag. Public JSON, no key needed."""

    name = "devto"

    def fetch(self, topic: str, limit: int, http: HttpGet) -> list[Observation]:
        query = urllib.parse.urlencode({"tag": topic, "per_page": str(min(limit, 30))})
        payload = http(f"https://dev.to/api/articles?{query}")
        out: list[Observation] = []
        for article in payload if isinstance(payload, list) else []:
            handle = (article.get("user") or {}).get("username")
            if not handle:
                continue
            out.append(
                Observation(
                    source=self.name,
                    handle=handle,
                    text=_excerpt(f"{article.get('title', '')} {' '.join(article.get('tag_list') or [])}"),
                    url=article.get("url", ""),
                    created_at=_iso(article.get("published_at") or article.get("created_at")),
                    topic=topic,
                    extra={"thread": article.get("url", "")},
                )
            )
        return out


class GitHubSource:
    """GitHub issue/PR search. Unauthenticated is rate limited; set GITHUB_TOKEN."""

    name = "github"

    def fetch(self, topic: str, limit: int, http: HttpGet) -> list[Observation]:
        query = urllib.parse.urlencode({
            "q": f"{topic} is:issue",
            "per_page": str(min(limit, 30)),
            "sort": "updated",
        })
        payload = http(f"https://api.github.com/search/issues?{query}")
        out: list[Observation] = []
        for item in payload.get("items", []):
            handle = (item.get("user") or {}).get("login")
            if not handle:
                continue
            out.append(
                Observation(
                    source=self.name,
                    handle=handle,
                    text=_excerpt(f"{item.get('title', '')} {item.get('body') or ''}"),
                    url=item.get("html_url", ""),
                    created_at=_iso(item.get("created_at")),
                    topic=topic,
                    extra={"thread": item.get("repository_url", "") + f"#{item.get('number')}"},
                )
            )
        return out


class BlueskySource:
    """Bluesky public post search. Public endpoint, no auth."""

    name = "bluesky"

    def fetch(self, topic: str, limit: int, http: HttpGet) -> list[Observation]:
        query = urllib.parse.urlencode({"q": topic, "limit": str(min(limit, 25))})
        payload = http(f"https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?{query}")
        out: list[Observation] = []
        for post in payload.get("posts", []):
            handle = (post.get("author") or {}).get("handle")
            if not handle:
                continue
            uri = post.get("uri", "")
            rkey = uri.rsplit("/", 1)[-1]
            out.append(
                Observation(
                    source=self.name,
                    handle=handle,
                    text=_excerpt((post.get("record") or {}).get("text", "")),
                    url=f"https://bsky.app/profile/{handle}/post/{rkey}" if rkey else "",
                    created_at=_iso(post.get("indexedAt")),
                    topic=topic,
                    extra={"thread": uri},
                )
            )
        return out


class TelegramPublicChannelSource:
    """A public Telegram channel, read through its own public web preview.

    Why this one is a `public_group` and not a scrape: a channel that enables the
    web preview is publishing its posts at `t.me/s/<name>` for anyone with a
    browser. Nobody is admitted, no membership is created, no member list exists
    to read, and the only actor visible is the channel.

    Consequence, and this is the point of the amendment: an observation from here
    describes **the group**, not a person. It feeds the community list. It can
    never produce an invitation, because you cannot invite a channel.

    The operator supplies channel handles explicitly (`--channels`). We never
    enumerate, discover, or guess channels, and we refuse anything that is not
    readable without joining.
    """

    name = "telegram_public"
    produces_individuals = False

    _POST = re.compile(r'data-post="([^"/]+)/(\d+)"')
    _TEXT = re.compile(r'class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', re.S)
    _TIME = re.compile(r'<time datetime="([^"]+)"')

    def fetch_channel(self, channel: str, limit: int, text_get: TextGet) -> list[Observation]:
        handle = channel.strip().lstrip("@")
        if not re.fullmatch(r"[A-Za-z0-9_]{3,64}", handle):
            raise ValueError(f"not a plausible public channel handle: {channel!r}")

        page = text_get(f"https://t.me/s/{handle}")
        if "tgme_widget_message" not in page:
            # No preview means the channel is not publicly readable. Treat that as
            # a refusal rather than silently returning nothing useful.
            raise ValueError(
                f"{handle} has no public web preview, so it is not a public group "
                "by our definition (readable without joining)"
            )

        blocks = list(self._POST.finditer(page))
        out: list[Observation] = []
        for index, block in enumerate(blocks):
            end = blocks[index + 1].start() if index + 1 < len(blocks) else len(page)
            segment = page[block.end():end]
            text_match = self._TEXT.search(segment)
            body = _strip_tags(text_match.group(1)) if text_match else ""
            time_match = self._TIME.search(segment)
            out.append(
                Observation(
                    source=self.name,
                    handle=block.group(1),
                    text=_excerpt(" ".join(body.split())),
                    url=f"https://t.me/{block.group(1)}/{block.group(2)}",
                    created_at=_iso(time_match.group(1) if time_match else None),
                    topic="",
                    extra={
                        "thread": f"tg:{block.group(1)}/{block.group(2)}",
                        "surface": "public_group",
                        "join_url": f"https://t.me/{block.group(1)}",
                    },
                )
            )
        return out[:limit]


class RedditSource:
    """Reddit. Off unless you have completed the OAuth + terms work.

    This class still exists so the policy is visible in code rather than in a
    README nobody reads: without credentials this returns nothing and says why.
    """

    name = "reddit"

    def __init__(self, enabled: bool = False, client_id: str = "", client_secret: str = "") -> None:
        self.enabled = enabled
        self.client_id = client_id
        self.client_secret = client_secret

    def fetch(self, topic: str, limit: int, http: HttpGet) -> list[Observation]:
        if not self.enabled or not (self.client_id and self.client_secret):
            return []
        token = self._token(http)
        if not token:
            return []
        # With a real token you would call oauth.reddit.com here. Left unimplemented
        # on purpose: shipping a half-working scraper is how projects get banned.
        return []

    def _token(self, http: HttpGet) -> str:
        return ""


def _scrub(observation: Observation) -> tuple[Observation, bool]:
    """Redact contact details and normalize the handle, on the way in.

    Returns (observation, whether anything was redacted) so the run report can
    say plainly that a source contained contact details we refused to keep.
    """
    cleaned, scrubbed = policy.scrub_pii(observation.text)
    return Observation(
        source=observation.source,
        handle=observation.handle.strip(),
        text=cleaned,
        url=observation.url,
        created_at=observation.created_at,
        topic=observation.topic,
        extra=dict(observation.extra),
    ), scrubbed


def _strip_tags(text: str) -> str:
    out, depth = [], 0
    for char in text:
        if char == "<":
            depth += 1
        elif char == ">":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(char)
    return "".join(out)


REGISTRY: dict[str, Any] = {
    "hackernews": HackerNewsSource(),
    "devto": DevToSource(),
    "github": GitHubSource(),
    "bluesky": BlueskySource(),
    "telegram_public": TelegramPublicChannelSource(),
    "reddit": RedditSource(
        enabled=os.environ.get("TANDEM_SCOUT_ENABLE", "") == "reddit",
        client_id=os.environ.get("REDDIT_CLIENT_ID", ""),
        client_secret=os.environ.get("REDDIT_CLIENT_SECRET", ""),
    ),
}


def collect(
    topics: list[str],
    sources: list[str],
    limit_per_topic: int = 20,
    http: HttpGet | None = None,
    pause_seconds: float = 0.0,
    channels: list[str] | None = None,
    text_get: TextGet | None = None,
) -> tuple[list[Observation], list[SourceReport]]:
    """Fetch every (topic, source) pair, with PII scrubbed on the way in.

    `channels` are public group handles the operator named by hand. Group sources
    read those instead of running a topic search, because a group is chosen, not
    discovered.
    """
    http = http or default_http_get
    text_get = text_get or default_text_get
    channels = channels or []
    observations: list[Observation] = []
    reports: list[SourceReport] = []

    for source_name in sources:
        policy.assert_source(source_name)
        surface = policy.surface_of(source_name)
        policy.assert_surface(surface)
        adapter = REGISTRY.get(source_name)
        if adapter is None:
            reports.append(SourceReport(source_name, "error", 0, "no adapter"))
            continue
        if source_name in policy.DISABLED_SOURCES and not getattr(adapter, "enabled", False):
            reports.append(SourceReport(source_name, "disabled", 0, policy.DISABLED_SOURCES[source_name]))
            continue

        found = 0
        note = ""
        dropped = 0
        try:
            if surface == "public_group":
                if not channels:
                    reports.append(SourceReport(
                        source_name, "needs-channels", 0,
                        "a public group is named, not discovered; pass --channels",
                    ))
                    continue
                batch: list[Observation] = []
                for channel in channels:
                    if pause_seconds:
                        time.sleep(pause_seconds)
                    batch.extend(adapter.fetch_channel(channel, limit_per_topic, text_get))
                policy.assert_group_admitted(
                    join_url=f"https://t.me/{batch[0].handle}" if batch else "",
                    readable_without_joining=bool(batch),
                )
                for observation in batch:
                    clean, was_scrubbed = _scrub(observation)
                    if was_scrubbed:
                        note = (note + " " if note else "") + "redacted contact details from public posts"
                    if _addresses_reader(clean, injection.DEFAULT):
                        dropped += 1
                        continue
                    observations.append(clean)
                    found += 1
                reports.append(SourceReport(
                    source_name, "ok" if found else "empty", found,
                    f"{len(channels)} public group(s), posts only",
                ))
                continue

            for topic in topics:
                if pause_seconds:
                    time.sleep(pause_seconds)
                for observation in adapter.fetch(topic, limit_per_topic, http):
                    clean, was_scrubbed = _scrub(observation)
                    if was_scrubbed:
                        note = (note + " " if note else "") + "redacted contact details from source text"
                    if _addresses_reader(clean, injection.DEFAULT):
                        dropped += 1
                        continue
                    observations.append(clean)
                    found += 1
        except injection.InjectionRefused as refused:
            note = (note + " " if note else "") + (
                f"{refused.attempt.rule}: connection closed, item not carried; "
                f"logged to {injection.DEFAULT.log_path.name}"
            )
            reports.append(SourceReport(source_name, "injection", found, note))
            continue
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, KeyError) as exc:
            reports.append(SourceReport(source_name, "error", found, f"{type(exc).__name__}: {exc}"))
            continue

        if dropped:
            note = (note + " " if note else "") + f"dropped {dropped} item(s) addressed to the reader"
        status = "injection" if dropped else ("ok" if found else "empty")
        reports.append(SourceReport(source_name, status, found, note))

    return observations, reports
