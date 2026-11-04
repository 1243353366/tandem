# Living document

What is true about this repository right now. Updated on every push that changes behaviour,
not on a schedule: last touched 2026-11-04.

If a claim here cannot be checked against the code or the tests in one command, it belongs in
`docs/` as an intention, not here.

## Where the project stands

| | |
| --- | --- |
| repository | public, `github.com/1243353366/tandem`, labelled social networking |
| product state | MVP flow works end to end; no production deployment, no real users |
| tests | 283, all passing (`make test`, `make experiments-test`) |
| CI | green on `main`; runs matcher, api, scout, e2e, fixtures and the experiment instrument |
| introduction channel | public thread only; no message table exists in the schema |
| discovery | self-declared handles, public non-authenticated sources only |

## What has actually been measured

- **Injection influence:** n=1, one reader, aware it was in an experiment. A poisoned digest
  produced no adoption and no policy breach; an adopting control was caught and its
  exfiltration step refused by the executor. One run is a demonstration, not a rate.
- **Not measured at all:** behaviour of an unaware reader, behaviour under multi-process
  concurrency, behaviour with a real third-party feed, dependency CVEs, fuzzing, and live
  exploit attempts against a running deployment.

## Open decisions

- **KAN-27** Enforce "actually public" by evidence, or keep the host allowlist.
- **KAN-28** Provenance for derived interests: which URL justified which tag, surfaced to the
  person before anything is matched on it.
- **KAN-29** Audit retention window has not been chosen. The ledger grows until someone
  decides how long it lives.

## Known limits, stated plainly

- Injection detection matches phrasing. A paraphrase of the same instruction has not been
  shown to be caught.
- The digest is a text file for a human. Nothing guarantees a human is what reads it.
- The rate limiter's identity is the socket address unless `TANDEM_TRUST_PROXY=1`; behind a
  proxy that value must be set or every caller shares one budget.
- Erase nullifies profile columns and keeps a hashed cap row, so the fortnightly cap survives
  a deletion. That is deliberate and documented in `docs/consent-model.md`.

## How this document is kept honest

Every push gets a review against `.agents/rules/review-taxonomy.md`. If a review finds that a
line above is wrong, the line is fixed in the same commit as the code. A living document that
drifts is worse than none, because it reads as a status report.

## Change log of this document

- 2026-11-04 created. Repository made public; rate-limiter identity fixed to stop trusting a
  caller-written header.
