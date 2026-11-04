"""Member-driven discovery.

The scout's original job was to find strangers who talk about a topic in public.
That was always the weaker half of the idea: it produces a cold invite underneath
somebody's post, and the consent question is settled by a rule rather than by the
person.

This module is the other half. A member adds **their own handle** to their
profile, with a consent scope that says what we may do with it. Then we read that
person's own public output and turn it into interest signals for their matching.

Nothing here searches for people. Every handle in this file was typed by the
person who owns it.

It is also worth being precise about the word "scraping", because adding a handle
does not change what a platform allows. It changes *who the reading is about*:

  - reading the platform's documented API, within its rate limits, is not scraping
  - reading it on behalf of the person who declared the handle is *their* data,
    with *their* consent, and revocable by them
  - reading a stranger's output and matching them without an account is the thing
    this whole project exists to avoid

So the adapters below are ordinary API clients with honest User-Agents, no
authentication bypassed, no pagination past the first page, and a hard cap on how
many items one member can contribute per run.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

_HERE = os.path.dirname(os.path.abspath(__file__))
_MATCHER = os.path.join(os.path.dirname(os.path.dirname(_HERE)), "matcher")
if _MATCHER not in sys.path:
    sys.path.insert(0, _MATCHER)

from . import policy  # noqa: E402
from . import signals as signal_mod  # noqa: E402

USER_AGENT = "tandem-scout/0.2 (member handle enrichment; +https://github.com)"

#: Callable returning parsed JSON for a URL. Injected in tests.
HttpGet = Callable[[str], Any]

#: One page of one member's own output. Small on purpose: this is enrichment, not
#: an archive. A member contributes a snapshot of what they are working on now.
MAX_ITEMS = 30


@dataclass
class MemberHandle:
    person_id: str
    network: str
    handle: str


@dataclass
class MemberSignals:
    person_id: str
    interests: list[str] = field(default_factory=list)
    observations: int = 0
    sources: list[str] = field(default_factory=list)
    evidence_urls: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        return {
            "person_id": self.person_id,
            "interests": self.interests,
            "observations": self.observations,
            "sources": self.sources,
            "evidence_urls": self.evidence_urls[:5],
        }


def default_http_get(url: str, timeout: float = 12.0) -> Any:
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


# ------------------------------------------------------------- adapters ----
#
# Each returns (text fragments, evidence urls) for one member's own account.


def _github(handle: str, http: HttpGet) -> tuple[list[str], list[str]]:
    repos = http(
        f"https://api.github.com/users/{urllib.parse.quote(handle)}/repos"
        f"?sort=pushed&per_page={min(MAX_ITEMS, 20)}"
    )
    texts, urls = [], []
    for repo in repos if isinstance(repos, list) else []:
        if repo.get("fork"):
            continue
        topics = " ".join(repo.get("topics") or [])
        texts.append(
            f"{repo.get('name', '')} {repo.get('description') or ''} "
            f"{repo.get('language') or ''} {topics}"
        )
        if repo.get("html_url"):
            urls.append(repo["html_url"])
    return texts, urls


def _hackernews(handle: str, http: HttpGet) -> tuple[list[str], list[str]]:
    query = urllib.parse.urlencode({
        "tags": f"comment,author_{handle}",
        "hitsPerPage": str(min(MAX_ITEMS, 30)),
    })
    payload = http(f"https://hn.algolia.com/api/v1/search?{query}")
    texts, urls = [], []
    for hit in payload.get("hits", []) if isinstance(payload, dict) else []:
        texts.append(f"{hit.get('comment_text') or ''} {hit.get('story_title') or ''}")
        if hit.get("objectID"):
            urls.append(f"https://news.ycombinator.com/item?id={hit['objectID']}")
    return texts, urls


def _devto(handle: str, http: HttpGet) -> tuple[list[str], list[str]]:
    payload = http(
        f"https://dev.to/api/articles?username={urllib.parse.quote(handle)}"
        f"&per_page={min(MAX_ITEMS, 30)}"
    )
    texts, urls = [], []
    for article in payload if isinstance(payload, list) else []:
        texts.append(f"{article.get('title', '')} {' '.join(article.get('tag_list') or [])}")
        if article.get("url"):
            urls.append(article["url"])
    return texts, urls


def _bluesky(handle: str, http: HttpGet) -> tuple[list[str], list[str]]:
    query = urllib.parse.urlencode({"actor": handle, "limit": str(min(MAX_ITEMS, 30))})
    payload = http(f"https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?{query}")
    texts, urls = [], []
    for item in payload.get("feed", []) if isinstance(payload, dict) else []:
        post = item.get("post") or {}
        record = post.get("record") or {}
        texts.append(record.get("text", ""))
        uri = post.get("uri", "")
        rkey = uri.rsplit("/", 1)[-1]
        if rkey:
            urls.append(f"https://bsky.app/profile/{handle}/post/{rkey}")
    return texts, urls


def _plain(raw: str) -> str:
    """Reduce an API's HTML payload to words. Tags carry no interest signal."""
    import html as html_mod
    import re as re_mod

    text = re_mod.sub(r"<[^>]+>", " ", raw or "")
    return re_mod.sub(r"\s+", " ", html_mod.unescape(text)).strip()


def _mastodon(handle: str, http: HttpGet) -> tuple[list[str], list[str]]:
    user, _, host = handle.partition("@")
    account = http(f"https://{host}/api/v1/accounts/lookup?acct={urllib.parse.quote(user)}")
    account_id = account.get("id")
    if not account_id:
        return [], []
    statuses = http(
        f"https://{host}/api/v1/accounts/{account_id}/statuses"
        f"?limit={MAX_ITEMS}&exclude_replies=true&exclude_reblogs=true"
    )
    texts, urls = [], []
    for status in statuses[:MAX_ITEMS]:
        texts.append(_plain(status.get("content", "")))
        if status.get("url"):
            urls.append(status["url"])
    return texts, urls


def _reddit(handle: str, http: HttpGet) -> tuple[list[str], list[str]]:
    payload = http(
        f"https://www.reddit.com/user/{urllib.parse.quote(handle)}/submitted.json?limit={MAX_ITEMS}"
    )
    children = ((payload or {}).get("data") or {}).get("children") or []
    texts, urls = [], []
    for child in children[:MAX_ITEMS]:
        data = child.get("data") or {}
        texts.append(
            " ".join(
                part for part in (data.get("title"), data.get("link_flair_text"), data.get("selftext", "")[:400]) if part
            )
        )
        if data.get("permalink"):
            urls.append("https://www.reddit.com" + data["permalink"])
    return texts, urls


def _gitlab(handle: str, http: HttpGet) -> tuple[list[str], list[str]]:
    users = http(f"https://gitlab.com/api/v4/users?username={urllib.parse.quote(handle)}")
    if not users:
        return [], []
    user_id = users[0].get("id")
    projects = http(
        f"https://gitlab.com/api/v4/users/{user_id}/projects"
        f"?per_page={MAX_ITEMS}&order_by=last_activity_at"
    )
    texts, urls = [], []
    for project in projects[:MAX_ITEMS]:
        topics = " ".join(project.get("topics") or [])
        texts.append(" ".join(part for part in (project.get("name"), project.get("description"), topics) if part))
        if project.get("web_url"):
            urls.append(project["web_url"])
    return texts, urls


def _codeberg(handle: str, http: HttpGet) -> tuple[list[str], list[str]]:
    repos = http(f"https://codeberg.org/api/v1/users/{urllib.parse.quote(handle)}/repos?limit={MAX_ITEMS}")
    texts, urls = [], []
    for repo in repos[:MAX_ITEMS]:
        if repo.get("fork"):
            continue
        texts.append(
            " ".join(part for part in (repo.get("name"), repo.get("description"), repo.get("language")) if part)
        )
        if repo.get("html_url"):
            urls.append(repo["html_url"])
    return texts, urls


def _stackoverflow(handle: str, http: HttpGet) -> tuple[list[str], list[str]]:
    payload = http(
        f"https://api.stackexchange.com/2.3/users/{urllib.parse.quote(handle)}/answers"
        f"?site=stackoverflow&pagesize={MAX_ITEMS}&filter=withbody"
    )
    texts, urls = [], []
    for item in (payload or {}).get("items", [])[:MAX_ITEMS]:
        texts.append(_plain(item.get("body", "")))
        if item.get("link"):
            urls.append(item["link"])
    return texts, urls


ADAPTERS = {
    "github": _github,
    "hackernews": _hackernews,
    "devto": _devto,
    "bluesky": _bluesky,
    "mastodon": _mastodon,
    "reddit": _reddit,
    "gitlab": _gitlab,
    "codeberg": _codeberg,
    "stackoverflow": _stackoverflow,
}

#: Networks a member can declare today, and whether we can read them yet. The
#: second column is the honest bit: a declared handle we cannot read is still
#: useful to the person (it is a link on their profile) but contributes nothing
#: to matching, and we should not pretend otherwise.
READABLE = frozenset(ADAPTERS)


# ---------------------------------------------------------------- enrich ----

def enrich_member(
    member: MemberHandle,
    http: HttpGet | None = None,
    max_tags: int = 8,
) -> MemberSignals:
    """Read one member's own declared account and derive interest tags."""
    http = http or default_http_get
    result = MemberSignals(person_id=member.person_id)

    adapter = ADAPTERS.get(member.network)
    if adapter is None:
        result.errors.append(
            f"{member.network}: no public reader (declared only: Snapchat groups are "
            "join-gated; see HANDLE_NETWORKS for the reason per network)"
        )
        return result

    try:
        texts, urls = adapter(member.handle, http)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, KeyError) as exc:
        result.errors.append(f"{member.network}: {type(exc).__name__}: {exc}")
        return result

    cleaned = [policy.scrub_pii(text)[0] for text in texts if text]
    result.observations = len(cleaned)
    result.evidence_urls = urls[:5]
    if cleaned:
        result.sources.append(member.network)
        result.interests = signal_mod.extract_interests(" ".join(cleaned), max_tags=max_tags)
    return result


def merge_member_signals(results: list[MemberSignals]) -> dict[str, MemberSignals]:
    """Fold several networks into one signal set per person.

    A tag written about on two platforms is a stronger signal than one, so the
    merge counts how many sources produced it and re-ranks.
    """
    merged: dict[str, MemberSignals] = {}
    for result in results:
        bucket = merged.setdefault(result.person_id, MemberSignals(person_id=result.person_id))
        bucket.observations += result.observations
        bucket.sources.extend(result.sources)
        bucket.evidence_urls.extend(result.evidence_urls)
        bucket.errors.extend(result.errors)
        counts: dict[str, int] = {}
        for tag in bucket.interests + result.interests:
            counts[tag] = counts.get(tag, 0) + 1
        bucket.interests = sorted(counts, key=lambda tag: (-counts[tag], tag))[:8]

    for bucket in merged.values():
        bucket.sources = sorted(set(bucket.sources))
        bucket.evidence_urls = list(dict.fromkeys(bucket.evidence_urls))[:5]
    return merged
