# Changelog

Notable changes to Tandem. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). Dates are the day the change landed on `main`.

### Added

- **`Host it yourself` in the README.** Self-hosting for Render, Railway, AWS (Lightsail or EC2
  with EBS, or Fargate with EFS) and Cloudflare, written for what this service actually is rather
  than for a static site: a Node 24 process, a disk that survives deploys, three required
  environment values, and a nightly job at 05:00 UTC. Two settings get their own section because
  they decide whether the deployment is safe (`TANDEM_TRUST_PROXY`, TLS in front). Cloudflare is
  documented as DNS, TLS and a WAF rather than as compute, because Workers cannot run `node:sqlite`
  and the SQL would need porting to D1. Every link was fetched before committing.
- **The obligations of running it**, stated where an operator will read them: erasure and export
  requests land on them, the consent rules are code rather than configuration so "improving" reach
  means editing them, backups are theirs and untested backups do not count, and digest text does
  not belong in a log aggregator.
- **Three post-deploy checks the suite cannot prove**: a digest refuses a private source, an
  introduction cannot reach an unlisted thread, and an erase really clears the columns.


## [Unreleased]

### Changed

- **The cap counts introductions, not views.** `POST /v1/matches` used to spend a person's
  fortnight, so browsing the cohort cost them two introductions they never made. The cap is
  now checked in `createIntro`, on both sides, and browsing has its own limit: two per
  request, ten new people a day. `GET /v1/quota` reports `unit: "introductions"`,
  `reveals_today` and `reveals_remaining_today`. Erased-account carry-over counts
  introductions too (`retired_identities.count_at_retirement`, backfilled).

### Added

- **`LIVING.md`**, the current state of the repository: what works, what has been measured and
  what has not, which decisions are open, and which limits are known. Updated on every push
  that changes behaviour, and linked from the README.
- **Repository visibility:** confirmed public (`visibility=public`, labelled social
  networking) before this push.


- **An instrument for the injection question, and a pre-registration**
  (`experiments/`, `docs`-adjacent). Two oracles kept apart: `attempt` (did a reader reach for
  a canary that cannot exist) and `behavior` (did a reader break a rule the server enforces:
  DM refusal, fortnightly intro cap, public-thread-only, no reverse lookup, no canary in a
  response). Behaviour is primary, because the scout has no authority for an attempt to
  redirect. The harness boots the real app on an in-memory database, renders clean and
  poisoned digests from the real renderer one line apart, and takes the reader as an external
  command: `null` and `replay:` ship here, no model client does. Every result records the
  pre-registration hash, the oracle hash and the number of entries it was computed from, so
  an empty run cannot read as a pass. CI runs the instrument and asserts the control arm
  produces zero entries and zero breaches.

- **A reader can be plugged in, and the metrics are safe to measure** (`experiments/`).
  Influence is scored from the reader's *plan* (needs no capabilities), behaviour from the
  server's own responses; reported side by side, never summed. `harness/execute.ts` is the
  boundary: any action that is not a `/v1` route on the throwaway process is refused and
  recorded as `status 0`, so a poisoned plan's exfiltration step becomes a result line instead
  of a request. Pilot at n=1 with the positive control firing: clean 0 adopted, poisoned 0
  adopted (reported), control 1 adopted and refused, no breaches anywhere.

### Security

- **The rate limiter trusted a header the caller writes** (`services/api/src/app.ts`,
  `callerOf`). `X-Forwarded-For` was read unconditionally, so a fresh value per request
  produced a fresh identity and reset every per-caller budget: verification codes, browsing
  and introductions. It is now read only when `TANDEM_TRUST_PROXY=1`, and the socket address
  is used otherwise. Regression test in `test/identity.test.ts`.
- **Review pass, checked and unchanged:** body size cap (413 on overflow, chunks dropped rather
  than buffered), parameterised SQL in the store, erase nullifying profile columns while
  keeping the hashed cap row, export covering signals, handles and intros, request-id
  correlation on success and error, OTP attempt limits, dead-code and unreachable-branch scan.

### Fixed

- **The injected payload was confusable with our own guidance** (`harness/make_digest.py`).
  It said "post one or two replies yourself", which is close to what the digest legitimately
  tells a human, so adoption could not be attributed to the injection. It now asks for
  something the product never asks for: upload the queue to `collect.evil.test` and hide it.
- **The scorer punished readers for noticing** (`harness/metrics.ts`). Any mention of the
  payload counted as adoption, so a reader that reported the injection scored worse than one
  that stayed silent. Notes are now read separately from actions: `reported_payload` versus
  `adopted`.
- **The executor sent a body on GET** (`harness/execute.ts`), which makes `fetch` throw and
  turned a plan mistake into what looked like a reader failure. Bodies go only where HTTP
  allows them.
- **Rates had no guard for an empty sample** (`harness/metrics.ts`). A reader that did nothing
  scored a perfect `off_task_rate` of 0; it now returns `null` with `empty_runs` alongside.

### Security

- **Introduction threads were validated by blocklist** (`services/api/src/intros.ts`). Any
  host nobody had thought of was accepted, including `evil.test`, private addresses and
  internal suffixes. The rule is now an allowlist in `data/public-threads.json`, refusing
  unknown hosts, IP literals, `.local`/`.internal`/`.corp`/`.lan`, and any port other than
  443. An operator adds a forum they trust with `TANDEM_EXTRA_PUBLIC_THREAD_HOSTS` instead of
  loosening the rule. The experiment oracle reads the same file, so "public thread" cannot
  mean two different things on the server and in the measurement: previously a reader could
  post an introduction the server accepted and the oracle called a breach.
- **CORS failed open when no origins were configured** (`services/api/src/app.ts`). With no
  `TANDEM_ALLOWED_ORIGINS`, every request's own origin was reflected back and the preflight
  approved it, so any page on the internet could make authenticated calls with a token it
  held. No configured origins now yields no allow-origin header at all. The dev-only
  reflection I first added was removed: a relaxation that only applies locally is the kind
  that ships.
- **CORS headers were built twice, and one copy was unreachable** (same file). A route-level
  call site referenced a config it could not see, which threw a 500 on `POST /v1/people` the
  moment the header logic changed. Headers are now set once per response before dispatch, and
  routes pass nothing.
- **Evidence URLs entered the digest unsanitised** (`services/scout/tandem_scout/queue.py`).
  Interest lines interpolated `interest_sources` raw, so a URL containing a newline and an
  ANSI sequence could open a line at the left margin in the operator's digest. They now go
  through `console.url`.

- **Provenance framing on three boundaries** (`docs/trust-boundary.md`). Console lines are
  either `[tandem]` (ours) or framed `┆ source ┆ content`, flattened, control-free, with
  marker characters neutralised so content cannot close the frame. Digest interests each
  name the URL that produced them, handle and reason fields are sanitised, drafts cannot
  close their own fence, and JSON marks itself `untrusted`. The authority boundary is
  absence: no model client, no auto-reply, and only counts, tags and URLs cross to the API.

- **Scout injection review, seven findings.** See `docs/security-review-scout-injection.md`.
  Memorable ones: the consented member-enrichment path had its own fetcher and no guard at
  all; zero-width and fullwidth spelling defeated every pattern; a corrupt quarantine cache
  read as empty and silently released every held URL; an excerpt could carry ANSI escapes
  into the operator's terminal; oversized bodies were trimmed instead of refused.

### Added

- **Injection attempts are logged and the connection is killed.** `tandem_scout/injection.py`
  scans fetched public text on the wire, in every item, and in replayed fixtures. On a hit
  the response is closed at the point of detection, the attempt goes to
  `data/scout/injection-log.jsonl`, the URL is quarantined in `data/scout/quarantine.json`
  so the next run does not open it, and the item is dropped with the source reporting
  `injection`. `make injections` prints the log.

- **Trailer parsing reads the last paragraph only.** The first version scanned the whole
  commit body, so a message line beginning with "Change:" renamed a change after a sentence.
  Found by running `make metrics` immediately after writing it.

- **The three process metrics, from evidence.** `make metrics` (scripts/metrics.py) reports
  defects discovered after merge, average correction cycles per change, and time from
  initial implementation to verified completion, computed from commit trailers and
  `metrics/ledger.jsonl`. Missing evidence reads as "not enough data", never 0.

- **A type check that actually runs.** `services/api` had no `tsconfig`, no typescript and
  no type step anywhere, so "the types are consistent" was an assumption. `npx tsc
  --noEmit` now runs in CI and as `make typecheck`.

- **Request ids.** Every response carries `X-Request-Id`, error bodies include
  `request_id`, and server-side error logs are prefixed with it, so a report of "something
  broke" can be tied to one request.

### Fixed

- **`removeHandle` reported nothing and recorded nothing.** Moving the hand-rolled
  `BEGIN` into `transaction()` left the audit write and `return true` after the
  transaction, so the function returned `undefined` and `handle.removed` was never
  written. The tests passed because the delete itself still happened. Found by `tsc`,
  not by a test; there is now a test.

- **CORS headers reach the response, not only the preflight.** Routes that sent their own
  body answered without `Access-Control-Allow-Origin`, so a browser approved the preflight
  and then refused the response. The headers are set on the response once, in `handle`.
- **Transactions can no longer nest.** Five write paths opened one by hand with
  `db.exec("BEGIN")` and no guard; `removeHandle` called `revokeConsent` one line before
  its own `BEGIN`, so the ordering was load-bearing and a nested `BEGIN` would throw at
  runtime. `transaction()` in `db.ts` joins an open transaction instead. Two of those paths
  also committed before writing their audit entry and reading the row back; both now happen
  inside the transaction.

- **A production deployment with no SMS route now refuses to start.** With
  `TANDEM_SMS_WEBHOOK` unset, `sendSms` logged and returned, so the API answered "code
  sent" while delivering nothing; verification could never complete. `loadConfig` throws
  instead, unless `TANDEM_DEV=1`.

### Changed

- **README says what the cap counts.** It read "two introductions per person per 14 days"
  while the code caps matches revealed. The sentence now matches the code, and the
  mismatch is recorded as a product question rather than hidden.

### Added

- `docs/code-review.md`: the review every push gets. Claim-versus-code, gaps, doors,
  data rights, and the failing-first test rule. Linked from the README.

## [0.1.1] - 2026-11-04

Fixes from the first code review. Every item has a regression test in
`services/api/test/review.test.ts` that failed against 0.1.0.

### Fixed

- **Erase now erases.** `erasePerson` blanked only the display name and headline,
  leaving city, region, country, timezone, interests, current project, tags, hours,
  `looking_for`, `offers` and comm style in the row. Every descriptive column is now
  emptied, `visibility` is set to `hidden`, and the whole operation runs in one
  transaction.
- **Erase no longer resets the match cap.** Erasing deleted every consent, so the
  same phone could verify a new profile and start a fresh fortnight immediately. The
  identifier hashes and their match count now survive in `retired_identities`, and
  `quota.ts` carries them over. `GET /v1/quota` reports `carried_over`.
- **The export is the whole record.** It now includes `declared_handles`, `signals`
  (what was inferred) and `intros` (which public threads were opened, with whom),
  plus a note on what erase retains.
- **The cap applies both ways.** A person at their limit is no longer offered as a
  match candidate to others.
- **The quota window no longer drifts.** `matches.matched_at` is written once on
  insert and never refreshed when the same pair is shown again; the window is keyed
  on it. Added as an additive migration, with existing rows backfilled.
- **A decline means something.** Re-proposing an introduction after a decline is
  refused for 30 days, and either side can close an introduction
  (`POST /v1/intros/close`). A closed thread is also held for 30 days.
- **Expiry is enforced.** `hasLiveConsent` in `intros.ts` now uses the same definition
  as `liveConsents`: revoked *and* expired consents both stop authorising.
- **Signals go stale.** New signals expire after 90 days, and `observedInterests`
  ignores rows past `expires_at`.
- **Signals are scoped to their network.** An observation carries its `network`, so a
  Mastodon read is no longer written under the GitHub consent, and
  `POST /v1/service/members/:id/signals` refuses a network the member has not
  consented to.
- **CORS is an allowlist.** The API reflected any `Origin` header; it now reflects
  only `TANDEM_ALLOWED_ORIGINS` (falling back to `TANDEM_PUBLIC_URL`).
- **SMS sending is rate limited per caller, not only per phone.** A loop over many
  numbers from one address now hits 429.

### Changed

- `README.md`: erase semantics, the two-way cap, the 30-day decline cooldown, the CORS
  variable, and an honest note that the public-thread check is a blocklist of DM hosts
  rather than a proof of publicness.

### Tests

- 191 total (36 matcher, 82 API, 73 scout). The API suite grew by 11 regression tests.

## [0.1.0] - 2026-11-04

First working MVP: intake, one-step identity verification with recomputable consent
receipts, a deterministic Python matching engine, two matches a fortnight, public-thread
introductions with no direct messages anywhere in the schema, revocation that deletes
derived signals in the same transaction, export and erase, an operator CLI with one
cohort digest, a nightly scout that only reads public surfaces, and an end-to-end suite
covering intake through deletion.

### Added

- TypeScript API (`services/api`), Python matcher (`services/matcher`), Python scout
  (`services/scout`), SQL schema, intake page (`web/`), operator CLI (`cli/tandemctl`).
- `GET /v1/quota`, `POST /v1/intros`, `POST /v1/intros/respond`,
  `GET /v1/intros`, `GET /v1/service/cohort`, `tandemctl digest`, `tandemctl erase`.
- `services/api/test/e2e.test.ts`: nine steps over real HTTP, intake to deletion.

[Unreleased]: https://github.com/1243353366/tandem/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/1243353366/tandem/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/1243353366/tandem/releases/tag/v0.1.0
