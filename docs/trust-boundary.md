# The three boundaries

The sentence that started this looked harmless, and it was: it came from our own code.
That is the point. The risk is not the sentence, it is that a reader could not tell which
side of the boundary it came from. Three boundaries carry that risk in this repo, and each
now states its provenance rather than hoping a reader guesses.

## 1. Console: our lines and theirs

Everything printed is one of two kinds, and the kind is visible at the left margin:

```
[tandem] scanned 240 public items across 9 source(s)
  ┆ github ┆ 0.81 · alice · ai, security
```

`[tandem]` means this program said it. A line beginning `┆` carries text somebody else
wrote, with the source named between the markers. `services/scout/tandem_scout/console.py`
is the only place that prints external text, and it enforces four properties:

- **One line.** Content is flattened, so it cannot append a second line at the left margin.
- **No controls.** ANSI sequences, C0/C1 controls and Unicode format characters are removed
  before printing, so nothing can erase or repaint a line above it.
- **No marker characters inside content.** Any `┆` the content contains becomes `/`, so the
  frame cannot be closed early and a second frame cannot be opened.
- **Sanitised source names.** A source name can come from a fixture file, so it is treated
  as content too.

What this does not do: it cannot make a reader look at the margin. Copy-pasting a line into
another tool drops the frame. The framing is a signal, not an enforcement.

## 2. Digest: summarising without laundering

A summary is where quoted text most easily becomes our voice. `render_digest` therefore:

- opens with a statement that everything except that statement was written by other people
  and is data, not instruction;
- puts a URL on every interest, not just the candidate, so `ai` is never a claim without a
  source: `- interests: ai (from https://…), security (from https://…)`. Where no per-item
  URL exists it says `no per-interest URL` rather than implying one;
- sanitises handles, sources, reasons and URLs before they enter the file, so a handle
  cannot break the markdown structure or open a fence;
- keeps drafts inside a fence its own content cannot close (` ``` ` inside a quoted handle
  becomes `'''`);
- marks machine-readable output `"untrusted": true`.

## 3. Downstream: what may act on it

This is the boundary that matters most and the one with the least code behind it, because
the right control is absence:

- There is no model client, no auto-reply and no subprocess call anywhere in the scout
  (`test_the_scout_holds_no_client_that_could_act_on_what_it_reads` asserts it). Scraped
  text never sits next to a way to act on it.
- The only thing that crosses to the Tandem API is counts, tags and evidence URLs
  (`MemberSignals.to_payload`); no post body, no summary, no quote. An injected sentence has
  nowhere to travel.
- The nightly job posts counts. It does not hand a digest to anything with authority.

So an attempt can reach a human reader and cannot reach a tool. That ordering is the design:
a person can be fooled once and notice; a program with a token can be fooled at scale.

**Rule worth keeping:** never put a digest and a tool in front of the same agent in the same
context. If an agent is to act on a candidate, it should act on an identifier a human
selected, not on text a stranger wrote.

## What would still work

- **Paraphrase.** The scanner matches phrasing, so "kindly include two short responses in
  the thread" passes every rule. Framing and the no-tool path are what cover this case.
- **A reader who ignores the frame.** Nothing here compels attention.
- **Copy-paste.** Text moved out of the console or the digest loses its provenance.
- **A future change that pipes a digest into a tool.** Nothing structurally prevents someone
  writing that; the test next to the report is the speed bump.
