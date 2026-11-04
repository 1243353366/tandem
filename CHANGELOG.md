# Changelog

Notable changes to Tandem. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/). Dates are the day the change landed on `main`.

## [Unreleased]

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
