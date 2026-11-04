# Matching

`services/matcher` is about 500 lines of Python with no dependencies. It exists
so that a match can be argued with.

## Why not embeddings

An embedding-based matcher would produce better scores on a large dataset and a
worse product on a small one, for three reasons:

1. **It cannot be explained.** "Cosine similarity 0.81" is not a reason a person
   can accept or reject.
2. **It hides the interesting failure.** The reason two people should meet is
   usually one specific thing ("you both want a co-founder and both have python
   on the bench"), and a dense vector smears that into a number.
3. **It is unauditable.** If a match ranks a demographic differently, you cannot
   point at the factor.

The three-way trade was made deliberately: explainability, small-data
performance, auditability over raw accuracy. If Tandem ever has 100k profiles,
that trade flips and the engine changes.

## Factors

| factor | weight | measures | failure mode it catches |
| --- | --- | --- | --- |
| `goal` | 0.30 | reciprocity: does each want what the other offers | two people who want mentors, not each other |
| `interest` | 0.25 | canonical tag overlap + current project overlap | "we both like tech" |
| `availability` | 0.15 | hours/week as a ratio | 2h vs 30h |
| `communication` | 0.12 | pace, directness, group size, channels | async writer vs sync caller |
| `timezone` | 0.10 | working-hours overlap | 12h apart |
| `momentum` | 0.08 | is something on the bench right now | a profile, not a project |

Weights sum to 1.0 and that is asserted at import time, so a typo cannot silently
change the product.

## Goal: the part that matters

Two matrices, not one.

**Peer compatibility** — both people want the same *kind* of relationship:

```
(friend, friend)               1.00
(cofounder, cofounder)         1.00
(collaborator, collaborator)   0.90
(cofounder, collaborator)      0.85
(study_partner, study_partner) 1.00
(accountability, accountability) 1.00
(mentor, mentee)               1.00   ← the one complementary pair
(mentor, mentor)               0.10   ← both want a mentor; not each other
(mentee, mentee)               0.10
```

**Fill compatibility** — A wants `x`, B offers `y`: can B actually do it. This is
what makes a one-sided ask into a reciprocal pairing. Someone who wants a mentor
and someone who *offers* to mentor score 1.00 even if the second person never
filled in "looking for".

```
goal = max(peer_best, fill(a→b), fill(b→a))
```

Two hard rules:

- **If either person has no stated goal, the goal factor is 0.0.** We do not infer
  what someone wants from what they offer, because a guess that produces a match
  is a guess the other person acts on.
- **`goal == 0` caps the total score at 0.22** (`ONEWAY_CAP`) regardless of
  everything else. Highest-scoring pair without a shared goal is still worse than
  the lowest-scoring pair with one.

## Interests

Tags go through a closed vocabulary with synonym folding, so `ML`,
`machine-learning`, `llms`, and `AI` are one thing (`ai`), and `cybersec`,
`infosec`, `appsec`, `privacy` are `security`. 21 groups, aliases in
`services/matcher/tandem_matcher/vocab.py`.

```
interest = 0.80 · jaccard(interests) + 0.20 · jaccard(project_tags)
```

Floored at 0.18 when there is at least one shared tag, so a narrow but real
overlap is not punished for being narrow. Unknown tags survive normalization
rather than being dropped, so a niche that is not in the vocabulary still works
for exact matches.

## Availability

```
ratio = min(hours_a, hours_b) / max(hours_a, hours_b)
score = 0.40 + 0.60 · ratio
```

Asymmetric on purpose: 3h and 3h is a real match; 3h and 3h is *also* the same as
40h and 40h. What kills a pairing is the ratio, not the absolute number. Zero
hours (unstated) returns a neutral 0.35 and a blocker, rather than failing.

## Communication

Pace (async / mixed / sync) 35%, directness distance 20%, group size 20%, shared
channels 25%. `sync` vs `async` is a blocker, not just a penalty: it is the most
common reason a promising project pairing dies in week two.

## Timezone

Current UTC offset via `zoneinfo`, wrapped to ±12h, mapped to
`1.0 / 0.85 / 0.60 / 0.35 / 0.15`. This is the only clock-dependent factor, and it
depends on the *offset*, never on "now" as a signal. Missing timezone is neutral,
not fatal.

## Momentum

Both have a `current_project` → 1.0. One → 0.6. Neither → 0.2. Shared project tags
add 0.15. Cheap, and it separates people who describe themselves from people who
are building something.

## Explainability

Every score returns:

```json
{
  "score": 0.833,
  "breakdown": {
    "goal":         { "value": 1.0,  "weight": 0.30, "contribution": 0.300 },
    "interest":     { "value": 0.53, "weight": 0.25, "contribution": 0.132 },
    "availability": { "value": 1.0,  "weight": 0.15, "contribution": 0.150 },
    "communication":{ "value": 1.0,  "weight": 0.12, "contribution": 0.120 },
    "timezone":     { "value": 0.15, "weight": 0.10, "contribution": 0.015 },
    "momentum":     { "value": 1.0,  "weight": 0.08, "contribution": 0.080 }
  },
  "reasons": [
    "You want a project partner and they offer it",
    "Shares 2 interests: osint, security",
    "Similar time to give (6h and 6h per week)"
  ],
  "blockers": ["11.5h apart, almost no overlap"]
}
```

Contributions sum to the score (tested). `blockers` are not deductions; they are
the honest reason a 0.833 is not a 1.0, and they are what makes the card
interesting.

## Determinism

Same two profiles in, same number out. No randomness, no sampling, no "recently
active" boost that changes between requests. This is testable and it is tested:
`test_score_is_deterministic`.

## Caps and floors summary

| rule | value |
| --- | --- |
| no shared goal | cap 0.22 |
| either person unverified | cap 0.35 |
| below this, not shown | 0.30 |
| goal factor when a goal is unstated | 0.00 |

## Tuning

Weights are a module constant, not a config file, so changing them is a diff
someone reviews. If you tune them:

1. Change `WEIGHTS` in `scoring.py`.
2. Update `docs/matching.md` (this file) in the same commit.
3. Bump `ENGINE_VERSION`.
4. Run `make test-matcher` — several tests assert relationship *ordering*, not
   absolute values, so they survive tuning and catch regressions in behaviour.

## Open questions

- **Group matching** (3–5 people around one project) is not implemented. The
  factors mostly transfer; the reciprocity rule does not, and that is the hard
  part.
- **Skill complementarity.** Two people with identical skills are sometimes the
  worst co-founders. There is no "you cover what they don't" factor yet.
- **Reliability.** Nothing tracks whether a person has ever actually shown up.
  A "held a first session" signal would be the most valuable feature in the
  product and is deliberately absent until there is a way to collect it that
  people would consent to.
