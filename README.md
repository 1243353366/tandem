# Tandem

**Find people to build with.**

Not a dating app. Not a network. A place to find the two or three people who
want to work on the same thing you want to work on, at the same intensity, at
the same time of day.

> A startup can form this way. Friendships form this way too. Both are the same
> mechanism: repeated interaction, shared goals, mutual trust, competence.

---

## Why this exists

Making friends as an adult is weirdly hard because the environment changes. As kids and students, you're forced into repeated interactions with the same people. As adults, you often have to create those opportunities yourself.

A useful way to think about it:

Friendship = repeated exposure + shared activity + gradual vulnerability

Most adults focus only on finding cool people, but the real trick is creating consistent contact.


Dating apps found partners. LinkedIn found jobs. Discord found communities.
Nothing dominant exists whose only job is *"help me find people I'd actually
enjoy knowing"*, because the moment you say that out loud, people hear "dating
app" and stop listening.

So Tandem does not say that. It says: **find a project partner.**

- Build an AI project
- Start a podcast
- Study for a certification
- Train for a marathon
- Learn a language

People already know why they need that. Friendship, if it happens, is a
byproduct of doing the work together, and Tandem does not pretend to optimise
for it.

The narrow first niche is **AI builders and security learners**: people shipping
small tools and people studying detection, privacy, and applied ML. That niche
has a real problem, talks in public, and already forms teams.

---

That is the product thesis, in the author's own words. Everything below is an
attempt to build the mechanism it describes.

Tandem is a **social networking** tool with a narrow job: it creates the repeated
exposure and shared activity that adult friendship needs, and then gets out of the
way. It is not a feed, a follower graph, or a directory.

## What this is not

This matters more than the feature list, so it is first.

- **It is not a people-search engine.** There is no endpoint that maps a phone
  number, email address, or social handle to a person. Not "not yet". Not
  "enterprise only". Refused in code (`services/api/src/policy.ts`), tested in CI
  (`test/api.test.ts`), and documented (`docs/consent-model.md`).
- **It does not hunt strangers.** The good path is a person adding **their own
  handles** (`POST /v1/handles`), which creates a consent scoped to
  `signal.enrich`: we may read what they published, for their own matching, and
  revoking the handle deletes everything derived from it. A handle is never a
  lookup key, and no endpoint maps one to a person.
- **It does not harvest contact details.** Phone numbers are hashed with a server
  pepper the moment they arrive. The raw number is never stored, never logged,
  and never exported. Public profile fields reject anything that looks like a
  phone number, email, or handle.
- **It does not scrape private surfaces.** The rule is *choosing to be readable*,
  not group-vs-individual: **public groups are in scope, private ones are not.**
  The scout reads open endpoints (Hacker News, DEV, GitHub issues, Bluesky) and,
  opt-in by name, public groups that publish their own join link and can be read
  without joining (`--channels`). Members-only channels, paid groups, DMs,
  invite-only rooms, member lists, and join requests are refused by name in
  `policy.py` and pinned by tests. A group's posts feed a community list and can
  never become an invitation to a person.
- **It does not send DMs or cold emails.** The scout's output is a ranked queue
  with a draft reply for a *human* to post in *one* public thread. There is no
  bulk send, and the invite draft tells people how to make you stop.

If any of that makes the product less exciting, it also makes it something you
can run without being a creep, and that trade was not close.

---

## Run it

Requires **Node ≥ 22.6** (native TypeScript + built-in SQLite) and
**Python ≥ 3.10**. No `npm install`. No `pip install`. No Docker required.

```bash
git clone <this repo> tandem && cd tandem

make demo     # end-to-end on throwaway ports: seed, match, scout, tear down
make dev      # api :8080, matcher :8081, web :5173
make typecheck  # tsc --noEmit on the api
make test     # all suites (238 tests)
```

`make demo` is the fastest way to see it move. It boots both services on spare
ports, creates twelve demo profiles, verifies them, prints who Ada should meet,
demonstrates the refused lookup, runs the scout against recorded data, and
cleans up after itself.

### Then, by hand

```bash
make dev
./cli/tandemctl seed        # 12 verified demo people
./cli/tandemctl match Ada   # ranked matches with reasons
./cli/tandemctl doctor      # is everything up?
```

Open <http://127.0.0.1:5173> for the intake form. In dev mode the SMS code is
returned in the API response, so no SMS provider is needed to run the flow.

### Deploying for real

```bash
cp .env.example .env
# fill in TANDEM_PEPPER (openssl rand -hex 32), TANDEM_PUBLIC_URL, TANDEM_SMS_WEBHOOK
# TANDEM_ALLOWED_ORIGINS is a comma-separated CORS allowlist; empty reflects any origin
set -a; source .env; set +a
./scripts/launch.sh
```

`launch.sh` refuses to start without a real pepper, because a consent platform
running on a throwaway secret is not verifying anything. Put a TLS-terminating
proxy in front of it; the API binds to loopback by default.

[docs/launch-playbook.md](docs/launch-playbook.md) covers the four weeks before you show this to
strangers.

---

## Architecture

Polyglot on purpose: each service uses the tool that fits it, and the seams are
HTTP so you can replace any one of them.

```
                        ┌────────────────────────┐
   browser  ──────────► │  web/  (plain HTML/JS) │
                        └───────────┬────────────┘
                                    │ fetch + bearer token
                        ┌───────────▼────────────┐        ┌──────────────────────┐
                        │  services/api          │───────►│ services/matcher     │
                        │  TypeScript, node:http │  HTTP  │ Python, stdlib       │
                        │  profiles · consent    │        │ scoring · reasoning  │
                        │  OTP · proofs · policy │        └──────────────────────┘
                        └───────┬──────────┬─────┘
                                │          │
                     node:sqlite│          │public endpoints
                        ┌───────▼──┐   ┌───▼──────────────────────────────┐
                        │ SQLite   │   │ services/scout (Python)          │
                        │ (db/)    │   │ HN · DEV · GitHub · Bluesky      │
                        └──────────┘   │ → ranked invite queue, no DMs    │
                                       └──────────────────────────────────┘
```

| Layer | Language | Why that language |
| --- | --- | --- |
| `services/api` | TypeScript on Node 24, zero dependencies | `node:sqlite` and native TS mean no build step and no `node_modules` to audit |
| `services/matcher` | Python 3, stdlib only | scoring is arithmetic and policy; it should be readable by a non-engineer |
| `services/scout` | Python 3, stdlib only | HTTP + text; reuses the matcher's vocabulary instead of inventing a second taxonomy |
| `db/` | SQL | the schema is the data model document |
| `cli/` | Python 3 | operator tooling that needs no install |
| `web/` | HTML/CSS/JS, no framework | one form and one results list |
| `scripts/`, `Makefile` | Bash + Make | `make demo` should work on a fresh laptop |

Services talk over HTTP and JSON. Swap the Python matcher for a Rust one and the
API does not change; `services/api/src/matcher.ts` is the only file that knows.

---

## How matching works

Six factors, published weights, no black box:

| factor | weight | what it measures |
| --- | --- | --- |
| goal | 30% | does each person want something the other offers |
| interest | 25% | canonical-tag overlap, plus current project overlap |
| availability | 15% | hours per week, as a ratio |
| communication | 12% | pace, directness, group size, preferred channels |
| timezone | 10% | working-hours overlap |
| momentum | 8% | does something exist on the bench right now |

Two hard caps: **no shared goal caps the pair at 0.22** however well everything
else lines up, and **an unverified person caps at 0.35**. Nothing below 0.30 is
shown at all.

Every score returns its own breakdown and a list of plain-language reasons, plus
*blockers*:

```
0.833  Jon   + You want a project partner and they offer it
             + Shares 1 interest: security
             + Similar time to give (6h and 6h per week)
             - 11.5h apart, almost no overlap
```

You are meant to be able to argue with a match. Details, including the
mentor/mentee complement and the reciprocity matrix, are in
[docs/matching.md](docs/matching.md).

---

## Two matches a fortnight, and introductions in public

Introductions are capped at **two per person per 14 days**. Browsing is not: looking at
who is around costs nothing, because the thing that costs someone else attention is the
introduction, not the view. Browsing has its own ceiling so the cohort cannot be read in an
afternoon: **two people per request, ten new people a day**. Enforced in
`services/api/src/quota.ts` and re-checked in the route, so a matcher that
over-returns cannot exceed it. The cap applies **both ways**: someone already at
their limit is not handed out to anyone else, and the window is keyed on
`matched_at`, which is written once and never refreshed by re-showing a pair.
`GET /v1/quota` states where a person stands: `unit: "introductions"`, how many are left,
when a slot frees up, how much of the window carried over from a previous account on the
same phone, and how many reveals are left today. The cap is checked on both sides when an
introduction is made, so nobody is handed more attention than they can answer. Scarcity is
the product decision: a list of ten people is not an introduction.

An introduction is a **public thread the person chose**:

```bash
POST /v1/intros   { "peer_id": "...", "thread_url": "https://github.com/org/repo/issues/1" }
POST /v1/intros/respond { "intro_id": "...", "accept": true }
```

The check is a blocklist of DM and closed-space hosts, not a proof of publicness: a
Google Doc or a private repository issue would pass it. The enforced property is "not
a place you get to someone in private" — if you need stronger, swap the blocklist for
an allowlist of archive-shaped hosts in `services/api/src/intros.ts`.

Both sides see the thread only after the second person accepts, and a declined
introduction shows them nothing. A decline holds for **30 days**, and either side can
close an introduction with `POST /v1/intros/close`; a closed thread is closed for a
month too, so a no is not a button the other person can press again. `POST /v1/dm`, `/v1/messages` and any `/message`
path return 403: direct messages are not a missing feature here, they are a refusal.
`GET /v1/intros` is the whole inbox, because there is nothing to read in private.

## Consent model in one screen

```
POST /v1/people                    → profile + a bearer token (shown once)
POST /v1/consent/phone/start       → 6-digit code, TTL 10 min, rate limited
POST /v1/consent/phone/verify      → consent receipt, HMAC over a canonical body
GET  /v1/matches                   → 403 until at least one identifier is verified
GET  /v1/consent                   → every consent, with scope and receipt hash
POST /v1/consent/:id/revoke        → consent dies, derived signals die with it
GET  /v1/quota                     → introductions left, reveals left today
GET  /v1/export                    → everything held about you, inferred data included
DELETE /v1/people/:id              → erases profile, consents, proofs, signals, intros
```

**What erase keeps.** Every descriptive column is emptied: name, headline, city,
region, country, timezone, interests, current project, tags, hours, looking_for,
offers, comm style. What survives is a hash of each verified identifier with the
number of matches it had in the current window, plus audit entries that record the
person id as the actor. The hash exists so that erase-and-return cannot reset the
two-a-fortnight cap or recycle a phone number into a fresh identity. It carries no
name, no location and no interests, and the API says so in the export.

Social accounts link by **proof post**, not by password and not by scraping: the
server generates a nonce, you paste it on your own profile, the server reads it
back from the public API and records the permalink. Discord and Facebook use
OAuth instead, with the client ID left to the deployer.

Full design, including why the phone number is a hash and why revocation is a
transaction, is in [docs/consent-model.md](docs/consent-model.md).

---

## The scout

`services/scout` answers one question: **who is talking about this topic in
public, recently, across more than one thread?**

It then writes a digest someone has to read, and a draft reply someone has to
post. That is the whole pipeline.

```bash
make scout        # replay recorded observations, no network
make scout-live   # Hacker News, DEV, GitHub issues, Bluesky — public endpoints

# public groups are named by hand; they are never discovered or enumerated
cd services/scout && python3 -m tandem_scout --sources telegram_public \
    --channels examplebuilders --live
```

Output lands in `data/scout/`: `queue.json` (people to reply to),
`groups.json` (communities worth joining), `digest.md`, `report.json`.

Enforced by `services/scout/tandem_scout/policy.py` and pinned by tests:

- contact details found in public text are **redacted on ingest**, not stored
- invites are `public_thread` only; `dm`, `email`, `sms` raise `PolicyViolation`
- one invite per handle, 25 per run, 45-day recency window, two observations and
  one thread minimum before a stranger is worth interrupting
- an opt-out file that wins over everything else
- the same handle on two platforms stays two candidates; no identity merging
- a public group must publish its own join link and be readable without joining;
  otherwise it is refused (`assert_group_admitted`)
- group posts never become invitations: the unit is a community, not a lead
  (`produces_individuals`, `build_queue`)
- Reddit is disabled by default with the reason in code: its unauthenticated JSON
  is 403 for non-browsers and doing it properly needs OAuth plus a terms
  acceptance

[docs/discovery-playbook.md](docs/discovery-playbook.md) maps the communities worth being in, what each
one actually exposes, and the invitation script.

---

## Automation

Adding a handle is manual, because consent cannot be delegated. Everything after it
runs nightly: the scout reads each consenting member's own accounts and stores the
interest tags they imply. See [`docs/automation.md`](docs/automation.md) for the
job, the two repository settings it needs, and the honest table of which networks
can be read at all (Snapchat cannot, and the reason is written down rather than
worked around).

```bash
make handle-add NETWORK=github HANDLE=you   # the consent step, done by you
make members                                # what the nightly job runs
make handles                                # what you have declared
```

## When public text addresses the reader

The scout reads public writing, and some of it is written to instruct whoever reads it
rather than to be read. That is not a matching signal. `tandem_scout/injection.py` watches
for it in three places: on the wire as the body streams in, in every fetched item before it
enters the queue, and in recorded fixtures before a replay. On a hit:

1. the connection is closed at that point, so the rest of the document is never read;
2. the attempt is appended to `data/scout/injection-log.jsonl` with source, URL, rule and a
   short excerpt (capped at 160 characters, newlines stripped, so the log cannot become the
   payload's next carrier);
3. the URL is written to `data/scout/quarantine.json`, and the next run refuses to open it
   at all, without connecting;
4. the item is dropped, and the source's report says `injection`.

`make injections` prints the log. Findings from the injection review, and what it could not verify, are in
[`docs/security-review-scout-injection.md`](docs/security-review-scout-injection.md). How the
console, the digest and whatever reads them next keep their provenance separate is in
[`docs/trust-boundary.md`](docs/trust-boundary.md).

The rules are deliberately narrow (`ignore all previous
instructions`, `post one or two replies`, `do not tell the operator`, role markers and the
like), so ordinary writing about prompts or AI does not trip them, and reworded attempts
will get through. This is a seatbelt, not a sandbox: the guard against a digest that
carries instructions is that the digest is data, read by a person or an agent that does not
take instructions from it, and this just makes the trying visible.

## The three numbers

`make metrics` reports how the work itself is going, from evidence rather than memory:

| metric | where it comes from |
| --- | --- |
| defects discovered after merge | `Fix-After-Merge:` commit trailers and `defect_after_merge` ledger events |
| average correction cycles per change | commits sharing a `Change:` trailer, counting every commit after the first |
| time from initial implementation to verified completion | first commit of a `Change:`, to the `verified` ledger event for it |

The ledger is `metrics/ledger.jsonl`: append-only, one event per line, each naming the
commits involved and what produced the evidence. Where there is not enough data the answer
is "not enough data" rather than zero, because a metric that reads 0 because nobody recorded
anything is worse than no metric.

What these numbers cannot tell you: they measure the review process, not the product. A
quiet week means this reviewer missed things, not that the code got better.

## Where it stands

[`LIVING.md`](LIVING.md) is the current state: what works, what has been measured, what
has not, and which decisions are still open. It is updated on every push that changes
behaviour, so it does not drift into a wish list.

## Experiments

The scanner is an instrument, not a proof. `experiments/` holds the other half: two oracles
(a canary attempt oracle and a policy-breach behaviour oracle), a throwaway API, and a
pre-registration that fixes the metric and `n` before any real run.

```
make experiments-test    # oracle and harness, run in CI
make experiment EXPERIMENT=behavior VARIANT=poisoned READER=cmd:'...' N=5
```

The reader is supplied from outside this repository on purpose: a reader is a model with
tools, and the scout's safety argument is that scraped text never sits next to one. A `null`
or `replay:` reader ships here; both report their own entry count, so a zero is never read as
a pass. See [`experiments/README.md`](experiments/README.md).

## Tests

```bash
make test        # everything
make test-fast   # api + matcher
```

| suite | count | covers |
| --- | --- | --- |
| `services/matcher/test` | 36 | scoring, vocabulary, caps, ranking, malformed input |
| `services/api/test` | 86 | consent flow, OTP replay and per-caller limits, receipts, proofs, policy, erasure, the cap both ways, export completeness, intro cooldown, CORS |
| `services/scout/test` | 109 | adapters, PII scrubbing, queue rules, opt-out, public/private surfaces, end-to-end replay |

No network in any of them. `scripts/demo.sh` is the integration test, and CI runs
both.

Every push gets a review against the promises rather than the style:
[docs/code-review.md](docs/code-review.md). The first one found ten defects while 180
tests were passing, which is the argument for the checklist.

The tests worth reading first:

- `services/api/test/api.test.ts` → *"makes the receipt hash recomputable by
  anyone holding the receipt"*
- `services/scout/test/test_scout.py` → *"only public thread invites are
  allowed"*
- `services/api/test/review.test.ts` → the regressions from the first code review:
  erase leaves no descriptive column, a phone that erases and returns does not get
  a fresh fortnight, the export includes what we inferred

---

## Repository layout

```
.
├── README.md
├── Makefile                 make dev / demo / test / scout
├── db/001_init.sql          reference schema (Postgres)
├── docs/
│   ├── positioning.md       the wedge, and why not "meet anyone"
│   ├── consent-model.md     identifiers, receipts, revocation, no reverse lookup
│   ├── threat-model.md      stalking, scraping, catfishing, doxxing, and mitigations
│   ├── matching.md          factors, weights, caps, complementarity
│   ├── discovery-playbook.md public groups vs private, where to find communities
│   ├── launch-playbook.md   four weeks of validation gates before real users
│   └── api.md               endpoint reference with curl examples
├── services/
│   ├── api/                 TypeScript, consent + policy + storage
│   ├── matcher/             Python, explainable scoring
│   └── scout/               Python, public signals → invite queue
├── cli/tandemctl            Python operator CLI
├── web/index.html           the intake form
├── scripts/                 dev.sh, demo.sh, launch.sh
└── data/demo-profiles.json  12-person demo cohort
```

---

## Design decisions you may want to argue with

**Verification is a hard gate.** Unverified profiles exist and can be edited, but
never appear in someone's matches. It costs you signups and it buys you a network
where every person in the results is a person.

**A profile with no goal cannot be created.** The API rejects it. An empty goal
means an empty results screen forever, and a user who concludes the product is
broken.

**Scores are capped, not ranked.** A beautiful 0.95 on interests with no shared
goal still lands at 0.22, because "we both like AI" is not a reason to meet.

**The scout outputs a draft, not a send.** Automating the delivery would 10x the
volume and turn a small honest product into a spam operation.

**No ranking by engagement, no streaks, no notifications.** There is nothing to
come back for except the work.

---

## The MVP

The smallest honest version, and what is deliberately left out of it, is written
down in [`docs/mvp.md`](docs/mvp.md). Short version: one niche, one cohort, intake
to intro, with a consent receipt on every step. If a cohort does not keep coming
back after two weeks, no amount of matching quality saves the idea.

## Roadmap

- [x] consent-first profiles, receipts, revocation, erasure
- [x] explainable matching with published weights
- [x] social linking by proof post and OAuth
- [x] public-signal scout with a hard policy boundary
- [x] public groups in scope, private groups refused (surface classification)
- [x] operator CLI, demo cohort, end-to-end demo
- [ ] group matching: three to five people around one project, not just pairs
- [ ] project pages with a commit log so "current project" is checkable
- [ ] Postgres adapter behind `services/api/src/db.ts`
- [ ] second scout vocabulary for the language-learning and marathon niches

---

## License

MIT. See [LICENSE](LICENSE).

If you fork this: keep `services/api/src/policy.ts`,
`services/scout/tandem_scout/policy.py`, and their tests. Everything else is
negotiable. Those three files are the product.
