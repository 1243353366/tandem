# Consent model

The platform's only scarce resource is trust, and trust here has a specific
meaning: **nothing about a person exists because someone else typed it.**

## The shape of it

```
profile (name, interests, project, hours)   ← typed by the person, public by choice
consent (kind, subject_hash, scope, expiry) ← written only after proof of control
signal  (tag, source, confidence)           ← derived, cites a consent, dies with it
match   (score, breakdown, reasons)         ← computed, inspectable
```

Four tables, three rules:

1. A row about a person exists because that person created it.
2. Every identifier we are allowed to touch has a consent row with a scope.
3. Revoking a consent deletes everything derived from it, in the same transaction.

## Identifiers are hashes, not secrets

A phone number arrives once, gets normalized to E.164, and immediately becomes

```
sha256_hmac(pepper, "phone:" + e164)   →   64 hex characters
```

The raw number is never written to the database, never written to a log, never
included in an export. `services/api/test/api.test.ts` asserts this by dumping
the `consents` and `phone_challenges` tables and searching for the digits.

Why a hash and not encryption:

- encryption implies we can decrypt, which implies a key that can be stolen,
  subpoenaed, or leaked. A hash removes the capability rather than guarding it.
- we never need the number back. We need to answer "did the person holding this
  number prove it", which is the same question as "does this hash match".
- a leaked database of hashes is not a phone directory unless the attacker
  already guesses the number. With a server-side pepper and rate-limited
  verification, guessing is not viable.

The pepper is `TANDEM_PEPPER`, required in production, and rotating it
invalidates every existing receipt. That is intentional: a receipt's value comes
from being verifiable against a specific policy epoch.

## Consent receipts

At the moment of proof, the server mints a receipt:

```json
{
  "v": 1,
  "person_id": "…",
  "kind": "phone",
  "subject_hash": "…",
  "scope": ["identity.verify", "match.signals"],
  "policy_version": "2026-11-01",
  "granted_at": "2026-11-04T18:53:07.221Z",
  "expires_at": null
}
```

`receipt_hash` is HMAC-SHA256 over the **canonical** form: sorted keys, no
whitespace, arrays in declared order. `services/api/src/consent.ts` and
`cli/tandemctl` implement the same canonicalization, so a holder can recompute
their own hash without asking us anything.

A receipt you cannot verify yourself is a promise, not a receipt.

Signing — as opposed to merely hashing — is the obvious next step and is *not*
implemented. It would let a third party verify a receipt without holding the
pepper. Until then, the honest claim is: the receipt proves the server said this
at this time, and the server is the only thing that can prove it. Say that in
your own deployment's copy rather than overclaiming.

## Scopes

| scope | grants | revoking it |
| --- | --- | --- |
| `identity.verify` | the profile may appear in anyone's matches | profile becomes unmatchable |
| `match.signals` | traits derived from this source may influence ranking | derived signals deleted |

Scopes are additive and revocable individually. There is no "necessary for
service" bundle, because the only truly necessary scope is `identity.verify` and
even that can be revoked at the cost of being findable.

## The proof flows

### Phone (SMS one-time code)

```
POST /v1/consent/phone/start   {phone}
  → normalizes, hashes, rejects if rate-limited (5/hour/person)
  → creates a challenge: 6 digits, 10 min TTL, 5 attempts, single use
  → SMS body: "Tandem verification code: NNNNNN. … If you did not request this, ignore it."

POST /v1/consent/phone/verify  {challenge_id, code}
  → constant-time compare, attempt counter, expiry check
  → on success: consume challenge, write consent, mint receipt
```

Deliberate details:

- **No number oracle at /start.** Requesting a code for a number that is already
  on another account looks identical to requesting one for a fresh number. The
  "this number is taken" message only appears at `/verify`, *after* the caller has
  proven they hold the phone. Otherwise the endpoint is a free existence check
  over every number in the country.
- **Attempts are counted, not just compared.** Five wrong codes and the challenge
  is dead.
- **Codes are single-use.** Replaying a successful verify returns `409`.
- **Dev mode returns the code.** `TANDEM_DEV=1` prints it in the response so you
  can run the flow without an SMS vendor. It also prints a warning at boot. Never
  deploy with it on; `scripts/launch.sh` refuses.

### Social accounts

Two mechanisms, because the platforms differ:

**Proof post** (GitHub, Bluesky, Mastodon). The server generates a nonce, the
person pastes `tandem:<nonce>` onto their own profile or a post, the server
fetches that public page via the platform's API and looks for the nonce.

- no password
- no OAuth app to register
- nothing read from anyone else
- the person can delete the proof afterwards; verification is not re-checked

Handle inputs are validated against a **whitelist** (`[A-Za-z0-9._@:-]`) before
they reach a URL, so a handle cannot be used to reshape a request.

**OAuth** (Discord, Facebook). Standard authorization-code flow, client ID and
secret supplied by the deployer. Discord's `identify guilds` scope returns the
account and server membership — Tandem reads the account and *never* attempts to
enumerate members of a server. Facebook has restricted profile access since 2018
and the metadata says so plainly rather than promising more than it can deliver.

## The no-reverse-lookup invariant

```ts
// services/api/src/policy.ts
export function assertNoReverseLookup(body, proofProvided) {
  if (proofProvided) return;
  const identifiers = ["phone", "phone_number", "email", "handle", "username", "subject"];
  const found = keys(body).filter(k => identifiers.includes(k));
  if (found.length) throw error("reverse_lookup");
}
```

Three independent guards:

1. `FORBIDDEN_ROUTE_PATTERNS` — paths like `/v1/lookup`, `/v1/search`,
   `/v1/people/by-phone` are refused at dispatch, before routing.
2. `assertNoReverseLookup` — any handler receiving an identifier without an
   accompanying proof flow throws.
3. The test suite asserts both, so a pull request that adds either one fails CI.

`POST /v1/lookup` exists and always returns `403` with an explanation. It is a
signpost, not a stub.

The database has no index, table, or column that goes from an identifier to a
person other than `consents.subject_hash → consents.person_id`, and that mapping
is written by exactly one code path.

## Revocation

```ts
db.exec("BEGIN");
UPDATE consents SET revoked_at = …
DELETE FROM signals WHERE consent_id = …
COMMIT;
```

A revocation that leaves derived data behind is a UI change, not a revocation.
The API reports `status: "revoked"` and matching is blocked again immediately if
it was the last live consent.

## Erasure

`DELETE /v1/people/:id` cascades: consents, proofs, challenges, signals, and
matches all go. The profile row is tombstoned (`status='erased'`, name replaced)
so other people's match history does not show a dangling reference, and one audit
row records that an erasure happened — with no identifier in it.

## Retention

| data | retention |
| --- | --- |
| OTP codes | deleted on use, or on expiry sweep |
| phone/handle hashes | until consent revoked, then until erasure |
| consent receipts | until erasure (they are the record) |
| social proofs | 24 h TTL for pending; verified rows until erasure |
| audit log | action names and hashes only, never identifiers |
| scout queue | local file, no identifiers beyond public handles |

## Export

`GET /v1/export` returns the profile, every consent with scope and receipt hash,
social proofs, and matches. It deliberately omits `subject_hash` and raw
identifiers, so a leaked export cannot be used to test guesses against a number.

## What is still missing

Honest gaps, in order of how much they matter:

1. **Signed receipts** (public-key verification without the pepper).
2. **Independent erasure audit** — today you have to trust the single DELETE.
3. **Key rotation story** for `TANDEM_PEPPER` that preserves old receipt validity.
4. **Per-field visibility** — right now a profile is `searchable` or `unlisted`.
5. **Delegate accounts** for someone who cannot complete an SMS flow.
