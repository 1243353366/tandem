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
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .models import Observation
from . import policy

USER_AGENT = "tandem-scout/0.1 (+https://github.com) public-signal discovery"

#: Callable that returns parsed JSON for a URL. Injected so tests never touch
#: the network and so a fork can plug in its own caching proxy.
HttpGet = Callable[[str], Any]


@dataclass
class SourceReport:
    source: str
    status: str            # 'ok' | 'disabled' | 'error' | 'empty'
    observations: int = 0
    note: str = ""


def default_http_get(url: str, timeout: float = 12.0) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


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
) -> tuple[list[Observation], list[SourceReport]]:
    """Fetch every (topic, source) pair, with PII scrubbed on the way in."""
    http = http or default_http_get
    observations: list[Observation] = []
    reports: list[SourceReport] = []

    for source_name in sources:
        policy.assert_source(source_name)
        adapter = REGISTRY.get(source_name)
        if adapter is None:
            reports.append(SourceReport(source_name, "error", 0, "no adapter"))
            continue
        if source_name in policy.DISABLED_SOURCES and not getattr(adapter, "enabled", False):
            reports.append(SourceReport(source_name, "disabled", 0, policy.DISABLED_SOURCES[source_name]))
            continue

        found = 0
        note = ""
        try:
            for topic in topics:
                if pause_seconds:
                    time.sleep(pause_seconds)
                for observation in adapter.fetch(topic, limit_per_topic, http):
                    cleaned, scrubbed = policy.scrub_pii(observation.text)
                    if scrubbed:
                        note = (note + " " if note else "") + "redacted contact details from source text"
                    observations.append(
                        Observation(
                            source=observation.source,
                            handle=observation.handle.strip(),
                            text=cleaned,
                            url=observation.url,
                            created_at=observation.created_at,
                            topic=observation.topic,
                            extra=dict(observation.extra),
                        )
                    )
                    found += 1
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, KeyError) as exc:
            reports.append(SourceReport(source_name, "error", found, f"{type(exc).__name__}: {exc}"))
            continue

        reports.append(SourceReport(source_name, "ok" if found else "empty", found, note))

    return observations, reports
