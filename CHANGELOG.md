# Changelog

Notable changes to Tandem. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). Dates are the day the change landed on `main`.

## [Unreleased]

### Changed

- **The cap counts introductions, not views.** `POST /v1/matches` used to spend a person's
  fortnight, so browsing the cohort cost them two introductions they never made. The cap is
  now checked in `createIntro`, on both sides, and browsing has its own limit: two per
  request, ten new people a day. `GET /v1/quota` reports `unit: "introductions"`,
  `reveals_today` and `reveals_remaining_today`. Erased-account carry-over counts
  introductions too (`retired_identities.count_at_retirement`, backfilled).

### Added

- **Injection attempts are logged and the connection is killed.** `tandem_scout/injection.py`
  scans fetched public text on the wire, in every item, and in replayed fixtures. On a hit
  the response is closed at the point of detection, the attempt goes to
  `data/scout/injection-log.jsonl`, the URL is quarantined in `data/scout/quarantine.json`
  so the next run does not open it, and the item is dropped with the source reporting
  `injection`. `make injections` prints the log.

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
