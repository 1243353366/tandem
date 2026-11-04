# Threat model

Written from the position that the interesting failures of a "find people"
product are not technical. They are social, and the technical controls only make
them survivable.

Scope: a self-hosted Tandem instance with real users. Out of scope: hosting
provider compromise, and anything requiring an attacker who already has root.

## Assets, ranked by damage if lost

| asset | why it matters |
| --- | --- |
| The phone-number → person mapping | the only thing standing between this and a people-search database |
| Consent receipts | the evidentiary basis for "they agreed to this" |
| The match graph | who contacted whom, and what they were looking for |
| Public profiles | already public; the risk is aggregation, not disclosure |
| Scout queue | public handles plus an inference; low but non-zero |

## Adversaries

| adversary | capability | goal |
| --- | --- | --- |
| **Stalker / ex-partner** | knows one phone number, is motivated, patient | find where the person is, or find anyone they know |
| **Scraper** | scripting, rotating IPs, will pay for accounts | build a searchable people database |
| **Spammer / recruiter** | many accounts, willingness to verify | reach many people with a pitch |
| **Catfish** | one real number (a VoIP line), time | build a false persona, extract money or access |
| **Harasser** | an account, possibly verified | reach one specific person repeatedly |
| **Curious insider / operator** | shell on the box, database read access | look someone up |
| **Well-meaning fork** | decides "just one lookup feature" is fine | undo the entire model |

The last row is the one that actually kills this category of product.

## Threats and mitigations

### 1. Reverse lookup by phone number

*Adversary: stalker. Attack: submit the victim's number and read their profile.*

- No endpoint accepts an identifier and returns a person. `policy.ts` refuses by
  pattern and by input shape.
- `/v1/lookup` returns `403` permanently.
- Residue: an attacker can *request a code* for a number and observe nothing
  distinguishing. `/start` is deliberately uniform. `409` appears only at
  `/verify`, after proof of control.
- **Residual risk: low.** The one leak path left is timing/coincidence on
  `/start`, mitigated by constant-shape responses and rate limits.

### 2. Scraping the match graph

*Adversary: scraper with accounts. Attack: verify many numbers, enumerate
profiles.*

- Verification is a hard gate on *appearing* in matches, not on requesting them.
  A verified attacker can still see verified profiles.
- Only profiles with `visibility='searchable'` are returned.
- Rate limits today: OTP 5/hour/person. **There is no per-account limit on
  `/v1/matches`.** This is the largest open hole in the current implementation
  and is called out in the roadmap rather than glossed over.
- Mitigation available now: run at invite-only scale. The launch playbook assumes
  tens of users, not thousands.

### 3. Spam and mass outreach

*Adversary: recruiter. Attack: verify a number, get matches, message everyone.*

- Tandem has no messaging surface at all. Matches are shown; the conversation
  happens wherever the two people choose (their own email, a Discord DM they
  initiate). That removes the vector rather than policing it.
- The scout cannot send anything. It emits a draft for a human.
- Cost of a verified account is one real phone number, which is the same cost as
  creating a burner WhatsApp, so verification is a speed bump and not a wall.
  Say so honestly; do not market SMS as identity.

### 4. Harassment of a specific person

*Adversary: an account holder. Attack: get matched, then persist across
platforms.*

- No contact details are ever exposed, so impact is limited to whatever the
  person shares themselves.
- A match requires **goal reciprocity** and both parties must be verified. A
  harasser cannot force themselves into one person's results repeatedly without
  also appearing in everyone's.
- `visibility: unlisted` exists: a person can stop appearing in results.
- **Missing:** block lists and per-person suppression. Today an unlisted profile
  cannot be found, but there is no "never show me this person" and no report
  path. Documented, not pretended otherwise.

### 5. Catfishing and fabricated competence

*Adversary: catfish. Attack: claim a project, claim skills, extract work or money.*

- Proof-post linking ties claims to an account with history, which is a real
  deterrent for GitHub and Bluesky: the account has to exist and have public
  output.
- The match card shows *verified channels*, so "no linked accounts" is visible
  rather than hidden.
- **Not mitigated:** we do not verify that someone's claimed project exists. The
  roadmap item "project pages with a commit log" is precisely about making that
  claim checkable.

### 6. Doxxing via proximity

*Adversary: anyone. Attack: combine city + timezone + hours + interests to
identify a specific person.*

- City is optional and free text; timezone is coarse; hours are a bucket.
- The combination is still identifying in a small population. **This is inherent
  to the product** — you cannot match by availability and location without
  revealing some of both.
- Mitigation is expectation-setting: the intake form says profile fields are
  public to verified users. `unlisted` exists for people who want matching
  without discoverability (they can request matches; they just will not appear in
  anyone else's).
- A fork serving a sensitive population (domestic abuse survivors, dissidents)
  should remove city and timezone entirely. Note it in your fork's README.

### 7. Scout misbehaviour

*Adversary: the operator, or a well-meaning fork. Attack: turn the scout into a
harvesting pipeline.*

- `policy.py` is written as prohibitions with tests, not as configuration:
  - `public_thread` is the only allowed invite channel; `dm`/`email`/`sms` raise.
  - Contact details in ingested text are redacted, not stored.
  - Opt-out file wins over all heuristics.
  - Caps: 1 per handle, 25 per run, 45-day window, 2 observations, 1 thread.
- The digest itself instructs the operator to post one or two, by hand.
- **Residual risk: moderate.** A determined operator can edit the file. The
  defence is that doing so is visible in a diff and obviously wrong.

### 8. Insider access

*Adversary: operator with shell.*

- Identifiers are hashes; there is nothing to read even with the database.
- The pepper lives in the environment, not the database, so a database dump alone
  cannot confirm a guessed phone number.
- **Not mitigated:** an operator with both the database and the environment can
  test guesses. Rotation invalidates all receipts, which makes abuse loud rather
  than silent. Beyond that, this needs an operator you trust, which is true of
  every self-hosted product.

## Invariants a security review should check first

1. No route maps an identifier to a person. (`policy.ts`, dispatch guard, test)
2. The raw phone number appears in no table, no log, no export. (table dumps in
   tests)
3. `/start` reveals nothing about whether a number is in use. (uniform response
   test)
4. Revocation deletes derived signals in the same transaction. (single-transaction
   revoke)
5. Unverified profiles are unreachable through matching. (candidate filter + engine
   cap)
6. Handles are whitelisted before reaching a URL. (regex + test)
7. Scout invites cannot leave `public_thread`. (`assert_invite_channel` + test)

## Things this product deliberately does not defend against

- Someone screenshotting a profile and posting it elsewhere.
- Two members of the same organisation recognising each other.
- A person misrepresenting their own availability or skills.
- A legal demand for a hash of a known phone number (it can be recomputed if the
  pepper is surrendered — say this to users if you operate at a scale where it
  matters).

The correct response to a threat outside scope is to say it is outside scope, not
to imply coverage.
