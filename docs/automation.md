# Automation: who adds handles, and what runs without them

The split is deliberate.

**A person adds their own handles, by hand.** That is the consent step and it stays
manual: nobody can truthfully agree on someone else's behalf, and a form that fills
itself in is not a form. `make handle-add NETWORK=github HANDLE=you` (or
`POST /v1/handles`) records the handle plus a consent scoped to `signal.enrich`.

**Everything after that is automated.** The nightly job reads each consenting
member's own accounts, derives interest tags, and stores them. Nobody runs a script.

```
person adds handle  ──▶  consent (signal.enrich)  ──▶  nightly scout reads that
   (manual, once)                                      account, one page deep
                                                              │
                        matching ◀── interest signals ◀────────┘
                        (uses tags as a tie-breaker, never as the main signal)
```

## The nightly job

`.github/workflows/scout-nightly.yml`, 05:00 UTC, or `workflow_dispatch`:

```bash
cd services/scout && python -m tandem_scout --members --api "$TANDEM_API"
```

Two settings in the repo, once:

| where | name | value |
| --- | --- | --- |
| Actions → Variables | `TANDEM_API` | your deployed API base URL |
| Actions → Secrets | `TANDEM_SERVICE_TOKEN` | same value as the API's `TANDEM_SERVICE_TOKEN` |

With no `TANDEM_API` set the job exits 0 and prints a notice, so a fresh fork is
quiet rather than red. The two `/v1/service/members` endpoints do not exist at all
outside dev mode without `TANDEM_SERVICE_TOKEN`, so an unconfigured deployment
returns 404 rather than publishing a member list.

Run it by hand any time with `make members`.

## Which networks are actually read

| network | read? | how |
| --- | --- | --- |
| GitHub | yes | `/users/:handle/repos`, documented, unauthenticated |
| Hacker News | yes | Algolia search API, filtered to `author_<handle>` |
| DEV Community | yes | `/api/articles?username=`, documented |
| Bluesky | yes | `public.api.bsky.app`, resolve DID then author feed |
| Mastodon | yes | `/api/v1/accounts/lookup` then that account's statuses |
| Reddit | yes | `/user/:handle/submitted.json`, the public JSON view |
| GitLab | yes | `/api/v4/users` then that user's public projects |
| Codeberg | yes | Gitea `/api/v1/users/:handle/repos` |
| Stack Overflow | yes | StackExchange API, answers by numeric user id |
| Personal site | yes | feed discovery, one page |
| **Snapchat** | **no** | see below |
| Instagram, Facebook, Threads, LinkedIn | no | content is behind a session |
| Telegram, Discord | no | content lives in joined/closed spaces |
| YouTube | no | needs a per-deployment API key |

Every reader is bounded by `MAX_ITEMS`, sends a real `User-Agent` identifying
`tandem-scout`, and reads exactly one page. There is no pagination crawler and no
follower-graph walk anywhere in this repository.

## Snapchat, specifically

Snapchat publishes no API for profile or group content, and its groups are joined
or invited into rather than public. So "scan public Snapchat groups" cannot be done
the way this repo does discovery: reading one would mean reading a closed space,
which is the one thing `policy.py` refuses.

What you *can* do, and what is implemented: declare the Snapchat handle. It appears
on your profile, it is matched on, and `GET /v1/handles/networks` reports it as
`readable: false` with the reason attached, so the person sees exactly what was and
was not agreed to. If Snapchat ships a public read API later, add a reader to
`services/scout/tandem_scout/members.py` and flip `readable` in `HANDLE_NETWORKS`.
The policy test suite will keep the refusal honest until then.

## Revoking

```bash
./scripts/add-handle.sh list
./scripts/add-handle.sh remove hnd_...
```

One transaction: the consent is revoked, and every signal derived under it is
deleted. The next match run simply has less to go on, which is the correct outcome.

## What automation must never do

- send an invite, a message or a notification to anyone the person did not choose
- grow a directory: no endpoint turns a handle into a person
- read a joined space, a private group, or a logged-in page
- exceed one page per account per run

The last one is cheap to violate accidentally and easy to check: `MAX_ITEMS` is the
only knob, and every reader passes it explicitly.
