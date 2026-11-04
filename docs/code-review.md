# The review every push gets

A review here is not a style pass. It is a check that the code keeps the promises the
README, the docs and the CLI make, and that nothing in the diff quietly widens a door.

This file is the checklist, not a suggestion. It exists because the first review of
Tandem found ten real defects while 180 tests were passing: erase that erased two
columns of nineteen, a cap that only applied outbound, an export that hid the inferred
data, and a decline that the proposer could simply press again.

## 1. Claim vs code

Find the sentence that makes the promise and the code that keeps it.

- Read the README section, the ticket, or the CLI output that changed.
- Open the function that is supposed to implement it.
- If the code does less than the sentence says, that is a finding even when the tests
  are green. Fix the code, or correct the sentence. Never leave the sentence stronger
  than the behaviour.

## 2. Gaps

Look for the half of a rule that was not written:

- A limit enforced for the requester but not for the person on the other side.
- An export that returns some tables and forgets the rest, especially derived data.
- A column written but never read (`expires_at` that nothing filters on, a flag no query
  honours).
- A migration with no upgrade test: open a database built from the old schema and check
  the backfill.
- A state any user can reset in one call, which quietly undoes a protection.

## 3. Doors

- CORS: does it reflect whatever `Origin` it is given? Is there an allowlist?
- Rate limits: per phone is not per caller; per user is not per address. Check both.
- Operator routes: do they require the service token outside dev mode?
- Errors: does a failure body disclose whether an identifier exists?
- Identifiers: does any endpoint resolve a handle, email or phone back to a person?

## 4. Data rights

Anything touching erase, export, revocation or retention:

- List the columns and confirm each one is cleared, rather than reading the function
  name.
- Say what survives (hashes, counts, audit) in the README and in the export itself.
- Confirm revocation deletes derived rows in the same transaction as the consent.

## 5. Tests that would have failed

For each finding, name the test that fails on the pre-fix code. If there isn't one, write
it first. A fix without a failing-first test is a hope.

Regressions live next to the feature tests; the review-fix batch is in
`services/api/test/review.test.ts`.

## Closing the loop

1. Fix in severity order.
2. Add the regression test per finding.
3. Add a CHANGELOG entry under `[Unreleased]`.
4. `make test`, push, confirm CI on the new commit.
5. Report findings plainly, ordered by what they cost, saying what was deliberately left
   alone and why.
