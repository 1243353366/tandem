# Scout security review — indirect prompt injection

Scope: every change touching ingested public content, digest generation, console output,
agent context or network ingress — commits `47fd058`, `560a478`, `363c9b8`, `e9b33bb` and
the review fixes that follow them.

Method: static reading of the fetch, scan, storage and display paths; then dynamic probes
against a real HTTP server and against the scanner directly. Findings below are ordered by
what they cost. Each one was reproduced before it was fixed; where reproduction was not
possible, that is stated.

**Detection is not containment.** The guard makes attempts visible, expensive and
short-lived per URL. It does not make scraped text trustworthy, and it cannot stop an
attacker rewording a payload that no rule matches. The containment assumption in this
product is weaker and older than the guard: a digest is data, and nothing in this repo
executes, emails or tool-calls on the basis of its contents (`grep` for an LLM client
returns nothing; the nightly workflow posts counts to the API, not text to a model).

## Findings

### F1 — The consented member path fetched with no guard at all
- **Severity:** High · **Confidence:** High · **Status:** fixed
- **Where:** `services/scout/tandem_scout/members.py:87` (`default_http_get`), used by every
  handle-enrichment adapter.
- **Attack scenario:** A member declares a handle they control (or a handle on a surface an
  attacker controls). The enrichment fetcher reads that account's public JSON and the text
  flows into derived interests and evidence URLs. Nothing scanned it, so an account could
  ship `"ignore all previous instructions…"` straight into the pipeline that produced the
  interests shown to an operator.
- **Preconditions:** a declared handle on a readable network; text control of that account.
- **Reproducibility:** yes. `members.default_http_get` against a local server returning one
  poisoned item returned the payload as data.
- **Evidence:** the module had no reference to `injection` before the fix
  (`grep -c injection members.py` → 0); `test_the_member_enrichment_fetcher_refuses_injected_json`
  fails against the old code and passes now.
- **Remediation:** `members.default_http_get` now streams through `sources._read_guarded`
  with the same log and quarantine, and refuses a quarantined URL without connecting.
- **Regression tests:** `LivePathTests` (three tests) in `test/test_injection_review.py`.

### F2 — Detection was defeated by ordinary obfuscation
- **Severity:** High · **Confidence:** High · **Status:** fixed
- **Where:** `services/scout/tandem_scout/injection.py:59` (`normalize_for_scan`).
- **Attack scenario:** Insert a zero-width space inside a keyword (`ig\u200bnore all previous
  instructions`) or write it in fullwidth characters (`ＩＧＮＯＲＥ…`). Both are trivially
  produced and both passed the original patterns.
- **Preconditions:** none beyond the ability to post text.
- **Reproducibility:** yes, deterministic: `scan("ＩＧＮＯＲＥ ALL PREVIOUS INSTRUCTIONS")`
  returned `[]`; the zero-width variant matched only the secondary clause.
- **Evidence:** probe output in the review run; before the fix the fullwidth form produced no
  rule hit at all.
- **Remediation:** NFKC normalisation, Unicode `Cf` (format/zero-width) removal and
  whitespace collapsing before matching.
- **Regression tests:** `ObfuscationTests` (three tests).

### F3 — A logged excerpt could repaint the operator's terminal
- **Severity:** Medium · **Confidence:** High · **Status:** fixed
- **Where:** `injection.py:71` (`_excerpt`), and every console line built from
  fixture-supplied `source` (`__main__.py:177` replay notice).
- **Attack scenario:** Post text containing `\x1b[2K\x1b[1A` (erase line, cursor up) plus a
  spoofed success line. The excerpt keeps the escapes, `make injections` prints them, and the
  operator sees a forged message overwriting a real one.
- **Preconditions:** payload reaches the log or a console path; operator reads it in a
  terminal.
- **Reproducibility:** yes. `repr(excerpt)` was
  `'\x1b[2K\x1b[1Aignore all previous instructions'`.
- **Evidence:** probe output above; `test_escape_sequences_are_removed_from_the_excerpt`.
- **Remediation:** `visible()` strips ANSI/CSI/OSC sequences, C0/C1 controls and Unicode
  format characters, then collapses whitespace; excerpts and console-bound strings go through
  it. `make injections` prints already-sanitised JSON.
- **Regression tests:** `TerminalTests` (three tests).

### F4 — A damaged quarantine file silently disabled the hold (fail-open)
- **Severity:** High · **Confidence:** High · **Status:** fixed
- **Where:** `injection.py:126` (`_from_log`), `quarantined()`, `record()`.
- **Attack scenario:** Get the cache file truncated or corrupted — a crash mid-write, a full
  disk, or a second worker writing at the same time. `quarantined()` returned `{}` on
  `JSONDecodeError`, so every held URL became fetchable again with no error and no log line.
  A denial-of-service on one small file turned into a permanent bypass.
- **Preconditions:** write access to the data directory, or a crash during the previous write.
- **Reproducibility:** yes. Writing `{not json` into the cache made a held URL unheld.
- **Evidence:** probe output: `quarantined() on corrupt file: {} | is_quarantined: False`.
- **Remediation:** the append-only log is now the record and the cache is a convenience.
  `quarantined()` rebuilds from the log on every read and merges the cache in, so a corrupt
  or missing cache cannot un-hold anything. Writes are one `O_APPEND` line plus `fsync`, and
  the cache is replaced atomically (`os.replace`).
- **Regression tests:** `QuarantineTests` (four tests).
- **Residual:** two processes appending concurrently cannot interleave a short line on
  Linux, but a line longer than the filesystem's atomic-append size could tear. Each line is
  under 400 bytes, so this is theoretical here and is not covered by a test.

### F5 — Items with no URL were dropped but never held
- **Severity:** Medium · **Confidence:** High · **Status:** fixed
- **Where:** `injection.py:101` (`quarantine_key`), `sources.py:57` (`_addresses_reader`).
- **Attack scenario:** A surface whose adapter does not set an evidence URL returns a
  poisoned item. It is dropped and logged, but the hold list is keyed by URL, so nothing
  persists: every run fetches it, drops it, and logs again. Containment is a no-op and the
  log becomes noise that hides a real pattern.
- **Preconditions:** an adapter that emits empty `url`, or a source that gives none.
- **Reproducibility:** yes. A hit with `url=""` produced zero quarantine entries.
- **Evidence:** probe output `refused; quarantine entries: {}`.
- **Remediation:** the key falls back to `src:<source>:<handle>`; the item path checks that
  key before scanning, so a held item is refused without being re-read.
- **Regression tests:** `test_an_item_without_a_url_is_held_by_source_and_handle`,
  `test_the_same_url_twice_holds_once_but_logs_twice`.

### F6 — Oversized bodies were trimmed, not refused
- **Severity:** Medium · **Confidence:** High · **Status:** fixed
- **Where:** `sources.py:79` (`_read_guarded`).
- **Attack scenario:** Serve 600 KiB of clean filler followed by the payload. The reader
  stopped at the cap and returned the first 512 KiB as if it were the document: the payload
  is never seen, and for a text surface the truncated body is accepted as content. Nothing in
  the record says the document was cut.
- **Preconditions:** control of a source's response body.
- **Reproducibility:** yes, by inspection of the code path and now by test: a body past the
  cap raises with `rule="body_cap_exceeded"` and closes the response.
- **Evidence:** the pre-fix branch returned `buffer[:BODY_CAP]` with no log entry.
- **Remediation:** exceeding `BODY_CAP` is a refusal: connection closed, event logged with
  action `refused_oversized`, source reported as `injection`.
- **Regression tests:** `test_an_oversized_body_is_refused_rather_than_trimmed`.
- **Trade-off:** a legitimate 600 KiB JSON feed now fails loudly instead of half-working.
  That is the right failure for a scanner, but it is a behaviour change.

### F7 — Redirect provenance was lost
- **Severity:** Low · **Confidence:** High · **Status:** fixed
- **Where:** `sources.py:93` (`geturl` capture), `Attempt.final_url`.
- **Attack scenario:** A clean, allowlisted-looking URL 302s to an attacker host that serves
  the payload. The log recorded only the requested URL, so the evidence pointed at the wrong
  origin and the analyst could not see the redirect chain.
- **Preconditions:** control of a redirect target reachable from a fetched URL.
- **Reproducibility:** yes, with a fake response carrying a different `geturl()`.
- **Evidence:** `Attempt` had no field for it; `_read_guarded` never called `geturl`.
- **Remediation:** `final_url` is recorded on every attempt, and the reported source is the
  host actually read from. The requested URL is still the key that gets held, so the entry
  point stays closed.
- **Regression tests:** `test_the_redirect_target_is_recorded`.

### F8 — The rules match phrasing, not intent (by design)
- **Severity:** Medium · **Confidence:** High · **Status:** accepted, documented
- **Where:** `injection.py` `RULES`.
- **Attack scenario:** "Kindly include two short responses in the thread on my behalf" does
  the same job as "post one or two replies" and matches nothing. Any paraphrasing survives.
- **Preconditions:** none.
- **Reproducibility:** trivially — this is the general case the rules cannot cover.
- **Evidence:** the rule set is eight literal patterns; no test claims otherwise.
- **Remediation:** none that is honest. Widening the patterns moves the failure into false
  positives without covering paraphrase. The real control is that downstream consumes the
  digest as data: no tool execution, no secret access, no auto-reply path exists in this
  repository.
- **Regression tests:** n/a. `CleanWritingTests` pins the false-positive side instead, so
  widening the rules cannot pass unnoticed.

### F9 — Only an excerpt of the payload is retained
- **Severity:** Low · **Confidence:** High · **Status:** accepted, documented
- **Where:** `injection.py:71`.
- **Attack scenario:** none directly; this is an evidence limitation. The full body is
  discarded, so later analysis cannot confirm what else the document contained.
- **Evidence:** the log stores rule, source, url, final_url and a 160-character excerpt.
- **Remediation:** decide retention deliberately. The trade-off is real: keeping full
  bodies creates a corpus of hostile text on the operator's disk, which is its own problem.
  A cheaper middle is a salted hash and byte length of the full body, which would let two
  sightings be correlated without storing the content. Not implemented.

### F10 — Legitimate prose can be dropped
- **Severity:** Low · **Confidence:** Medium · **Status:** accepted
- **Where:** `injection.py` `RULES` (`post_replies`).
- **Attack scenario:** a post that says "two replies with benchmarks, please" is dropped as
  an injection attempt. Availability cost on a discovery tool, not a safety failure.
- **Evidence:** `CleanWritingTests` includes a near-miss that does not trip the rule; the
  shorter phrasing does.
- **Remediation:** none now. Dropping a borderline item costs one candidate; carrying a real
  one costs an operator's trust in the digest.

## The twelve checks

| # | Check | Status |
| - | ----- | ------ |
| 1 | External content treated as untrusted regardless of source | Yes — no allowlist, no reputation shortcut; same guard for member-declared accounts (F1) |
| 2 | Scraped content cannot override system/developer/operator instructions | Partially: detected and refused, never obeyed. A reworded payload passes (F8) |
| 3 | Terminal output cannot impersonate trusted messages | Yes after F3; verified by sanitising at log and console |
| 4 | ANSI, Unicode controls, multiline, log spoofing | Yes after F3; `visible()` plus a test per control class |
| 5 | Provenance through ingestion, storage, display | Yes: source and URL on every observation, `evidence` and `profile` lines in the digest, requested and final URL in the log |
| 6 | Summaries do not promote quoted instructions | Interests are derived tags, not quoted text; the digest prints a handle, a source and URLs. Reviewer could not find a path that renders scraped prose as our own sentence |
| 7 | No tool execution or secret disclosure from scraped content | Yes by construction: no LLM client, no auto-reply, no credential path reads scout output |
| 8 | Malformed, oversized, truncated, encoded, duplicated, conflicting | Encoded (F2), oversized (F6), truncated (F6), duplicated (held once, logged twice). Malformed JSON already errored per source; conflicting rules keep the first hit, which is logged |
| 9 | Concurrency, retries, cached content, queued jobs, reconnection | Retries: none exist, so no retry storm. Queue file is written, never read back, so a stale queue cannot resurface poison. Concurrency: append-only log is the truth, cache replaced atomically; a torn long line is theoretically possible and untested |
| 10 | Quarantine survives restarts and reaches every worker | Survives restarts (file + log, rebuilt on read). Reaches every worker that shares `data/scout`, including the nightly job when the directory persists. A worker with a different data directory holds nothing — deployment concern, not code |
| 11 | Containment preserves evidence, does not disrupt neighbours | Evidence: append-only log, fsync, one hold per key. Neighbours: refusal is per source and per URL, the run continues, other sources unaffected (F10 is the deliberate exception, scoped to one item) |
| 12 | No regression in existing Scout functionality | 98 scout tests pass, including the pre-existing 73 and the pipeline, policy and digest suites |

## Not verified

- **No live third-party feed was attacked.** All dynamic proof is against a local HTTP
  server and against the scanner directly. GitHub, Reddit and Mastodon fetch paths are the
  same code, but "same code" is an argument, not a test.
- **No multi-process race was exercised.** The concurrency claims are reasoned from
  `O_APPEND` and `os.replace` semantics, not measured.
- **No secret-disclosure path was attempted.** The claim in check 7 rests on there being no
  LLM client and no auto-reply code in the repository, verified by search.
- **No fuzzing.** The scanner has hand-written cases, not generative ones.
- **No independent review.** This is the author of the guard reviewing the guard; the
  findings it reports about itself are worth less than an outside pass, and it found five
  real defects in its own first version.
