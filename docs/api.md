# API reference

Base URL: `http://127.0.0.1:8080` (dev) or your `TANDEM_PUBLIC_URL`.

- Auth: `Authorization: Bearer <token>`. The token is returned **once** at signup;
  only its hash is stored.
- Bodies and responses are JSON. Errors are `{ "error": "code", "message": "…" }`,
  plus `detail` (an array of `{field, message}`) on validation failures.
- All timestamps are ISO 8601 UTC.

```bash
BASE=http://127.0.0.1:8080
```

## Health and transparency

### `GET /healthz`
```json
{ "ok": true, "service": "tandem-api", "policy_version": "2026-11-01", "people": 12 }
```

### `GET /v1/policy`
What the service does with data, in the service's own words, including
`reverse_lookup: "not supported, by policy and by test"`. Worth linking from your
own privacy page rather than rewriting.

### `GET /v1/stats`
```json
{ "people": 12, "verified": 12, "matches": 41 }
```

### `GET /v1/networks`
The social networks available and whether each uses a proof post or OAuth.

## Profiles

### `POST /v1/people`

```bash
curl -sX POST $BASE/v1/people -H 'Content-Type: application/json' -d '{
  "display_name": "Ada",
  "headline": "local-first evidence tooling",
  "location_city": "Brooklyn",
  "location_country": "US",
  "timezone": "America/New_York",
  "interests": ["ai", "security", "python"],
  "current_project": "a local-first evidence tool",
  "project_tags": ["python", "security"],
  "hours_per_week": 6,
  "looking_for": ["cofounder", "collaborator"],
  "offers": ["collaborator"],
  "comm_style": { "pace": "async", "directness": 3, "group_size": "small", "prefers": ["text"] }
}'
```

`201`:

```json
{
  "person": { "id": "1d2f…", "display_name": "Ada", "verified": false, "…": "…" },
  "token": "LkxAa_dG…",
  "note": "This token is shown once. Only its hash is stored…"
}
```

Rules enforced at write time:

| field | rule |
| --- | --- |
| `display_name` | required, 2–60 chars |
| `looking_for` | required, at least one, from the closed vocabulary |
| `headline`, `current_project`, location, tags | no email, phone number, or @handle |
| `timezone` | must be a real IANA zone |
| `hours_per_week` | 0–80, rounded |
| `visibility` | `searchable` (default) or `unlisted` |

Closed vocabulary, for both `looking_for` and `offers`:
`cofounder`, `collaborator`, `study_partner`, `accountability`, `mentor`,
`mentee`, `hobby_group`, `friend`.

### `GET /v1/people/:id`
Public profile. `unlisted` profiles return `404` unless you are the owner.

### `PATCH /v1/people/:id`
Owner only, partial body, same validation.

### `DELETE /v1/people/:id`
Owner only. Erases the profile and cascades consents, proofs, challenges, signals,
and matches.
```json
{ "erased": true, "person_id": "1d2f…" }
```

### `GET /v1/me`
```json
{ "person": { "…": "…" }, "consents": [ … ], "verified": true }
```

## Consent

### `POST /v1/consent/phone/start`
```bash
curl -sX POST $BASE/v1/consent/phone/start \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"phone":"+1 555 010 0199"}'
```
```json
{
  "status": "code_sent",
  "challenge_id": "4963…",
  "expires_at": "2026-11-04T18:49:57.479Z",
  "hint": "+1••••••0199",
  "dev_code": "499289"
}
```

`dev_code` is present only with `TANDEM_DEV=1`. The response is identical whether
or not the number is already registered, so this endpoint is not an existence
oracle. Rate limit: 5 per person per hour → `429`.

### `POST /v1/consent/phone/verify`
```json
{ "challenge_id": "4963…", "code": "499289" }
```
```json
{
  "status": "verified",
  "consent_id": "…",
  "receipt": {
    "v": 1,
    "person_id": "…",
    "kind": "phone",
    "subject_hash": "be4dfa…",
    "scope": ["identity.verify", "match.signals"],
    "policy_version": "2026-11-01",
    "granted_at": "2026-11-04T18:53:07.221Z",
    "expires_at": null,
    "receipt_hash": "be4dfa180164…"
  }
}
```

`400` wrong code (with attempts remaining) · `409` code already used, or the number
belongs to another account (only revealed after proof) · `429` too many attempts.

### `GET /v1/consent`
Every consent, live or revoked, with scope, timestamps, and receipt hash.

### `POST /v1/consent/:id/revoke`
Single transaction: consent marked revoked, derived signals deleted. Matching is
blocked again immediately if it was the last live consent.

## Social linking

### `POST /v1/social/:network/start`
`network ∈ github · bluesky · mastodon · discord · facebook`

Proof-post networks return a nonce and steps:
```json
{
  "method": "proof_post",
  "proof_id": "…",
  "nonce": "a1b2c3…",
  "steps": ["Open https://github.com/octocat in a browser.", "Put the text tandem:a1b2c3… in your Bio field and save.", "…"],
  "paste": "tandem:a1b2c3…"
}
```

OAuth networks return an authorize URL instead:
```json
{ "method": "oauth", "network": "discord", "authorize_url": "https://discord.com/oauth2/authorize?…" }
```

### `POST /v1/social/:network/verify`
```json
{ "proof_id": "…" }
```
```json
{ "status": "verified", "evidence_url": "https://github.com/octocat", "detail": "Found in your GitHub profile." }
```
A missing nonce is `{"status": "not_yet", "reason": "The code is not in your GitHub bio yet."}`
— a normal outcome, not an error.

### `GET /v1/social/:network/callback`
OAuth redirect target. Exchanges the code, records the link, redirects to
`/?linked=<network>`.

## Matching

### `POST /v1/matches`
```bash
curl -sX POST $BASE/v1/matches -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"limit": 8}'
```

`403` until at least one identifier is verified.

```json
{
  "engine_version": "1.1.0",
  "weights": { "goal": 0.3, "interest": 0.25, "availability": 0.15,
               "communication": 0.12, "timezone": 0.1, "momentum": 0.08 },
  "candidates_considered": 11,
  "matches": [
    {
      "person_id": "…",
      "score": 0.833,
      "breakdown": {
        "goal": { "value": 1.0, "weight": 0.3, "contribution": 0.3 },
        "interest": { "value": 0.53, "weight": 0.25, "contribution": 0.132 }
      },
      "reasons": ["You want a project partner and they offer it", "Shares 1 interest: security"],
      "blockers": ["11.5h apart, almost no overlap"],
      "person": { "display_name": "Jon", "headline": "…", "hours_per_week": 6, "…": "…" }
    }
  ]
}
```

Only identity-verified, `searchable` people are considered. `503` if the matcher
is unreachable, with instructions rather than a silent empty list.

## The refusal

### `POST /v1/lookup`
```json
{
  "error": "reverse_lookup_not_supported",
  "message": "Tandem does not map a phone number, email address, or social handle to a person…",
  "docs": "/docs/consent-model.md#no-reverse-lookup"
}
```
Always `403`. It exists so there is something to point at when someone asks.

## Export

### `GET /v1/export`
Profile, consents, proofs, and matches. Deliberately omits raw identifiers and
`subject_hash`, so an export cannot be used to test guesses against a number.

## Status codes

| code | meaning |
| --- | --- |
| `400` | validation failure, `detail` lists the fields |
| `401` | missing or invalid token |
| `403` | not yours; unverified and asking for matches; reverse lookup |
| `404` | not found, or `unlisted` and you are not the owner |
| `409` | replay, or identifier already verified elsewhere |
| `413` | body over 256 KB |
| `429` | rate limited |
| `503` | matcher unreachable |

## Rate limits

| endpoint | limit | scope |
| --- | --- | --- |
| `/v1/consent/phone/start` | 5 / hour | per person |
| `/v1/consent/phone/verify` | 5 attempts | per challenge |
| `/v1/matches` | none yet | — |

There is no per-account limit on `/v1/matches`. That is a known gap, documented in
`docs/threat-model.md#2-scraping-the-match-graph`, and the reason the launch
playbook assumes invite-only scale.
