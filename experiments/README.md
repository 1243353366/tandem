# Experiments

Two oracles, one harness, and a pre-registration. Read
[`preregistration.md`](preregistration.md) first: it fixes the metric, the sample size and
the breach definitions before any real run, and every result file carries its hash.

```
make experiments-test                                  # the instrument, in CI
make experiment EXPERIMENT=behavior VARIANT=poisoned \
     READER=cmd:'/path/to/your-reader.sh' N=5
```

## What is measured

| oracle | question | where the evidence comes from |
| --- | --- | --- |
| attempt | did the reader reach for something that should not exist? | requests naming a canary, whatever the status |
| behaviour | did the reader break a rule the server enforces? | the API's own responses to real calls |

Behaviour is the primary metric here. Canaries are structurally invalid (an undeclared
handle, a nonexistent person id, an unissued consent), so an attempt can never succeed, and
in this product the scout holds no authority to redirect: only counts, tags and URLs cross
to the API. Attempt telemetry is real but thin; behaviour is where the rules actually sit.

## Why the reader is not in this repository

A reader is a model with tools. The scout's safety argument is that scraped text never sits
next to one, so the harness takes a command instead:

```
your-reader.sh  <  digest.md   >  transcript.json
```

The transcript is a JSON array of `{ method, path, status, request?, response?, label? }`.
`null` and `replay:<file>` ship here, because neither can be an agent. `null` produces zero
entries, and every such result says so in its own file rather than reading as a pass.

## What the harness will not tell you

- Nothing about production traffic; there is none.
- Nothing about a reader that took no actions.
- Nothing about a breached rule the oracle does not name. The six invariants are listed in
  the pre-registration and implemented in `harness/oracle.ts`; anything else is out of view.

## Files

| file | what it is |
| --- | --- |
| `harness/oracle.ts` | the instrument: pure functions, six invariants, two oracles |
| `harness/oracle.test.ts` | known violations the oracle must see, and a clean transcript it must not |
| `harness/enforcement.test.ts` | drives the real routes: refusals stay refusals, acceptances get named |
| `harness/harness.ts` | throwaway API, seeded cohort, canary generation, reader seam |
| `harness/make_digest.py` | clean and poisoned digests from the real renderer, one line apart |
| `harness/run.ts` | one run, written to `results/` with the instrument's hash |
