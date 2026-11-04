# [Epic] Tandem pilot: cohort 1 through intake, match and intro

**Filed:** KAN-4 (private Jira) · **Type:** Epic · **Priority:** High
**Labels:** `mvp` `social-networking` `consent` `cohort-1`
**Repo:** https://github.com/1243353366/tandem

## Context

Friendship = repeated exposure + shared activity + gradual vulnerability. Adults
have to manufacture the first two themselves, which is why "find cool people" fails
and "create consistent contact" works. Tandem exists to create that contact for one
narrow case: finding people to build something with.

This ticket is the MVP boundary, not a backlog. It ends when a small cohort has
actually stayed in contact, not when the features are done.

## Goal

Run one cohort of real people, for one niche (AI / security / tech builders),
through intake → match → intro, with a consent receipt on every step, and know
within four weeks whether they keep coming back.

## In scope

- Intake form with exactly: display name, location, interests, current project,
  hours available per week, looking for (friend / co-founder / study partner /
  mentor / accountability partner)
- One verification (phone code, or a linked account the person owns) issuing a
  consent receipt
- Matching on shared interests, availability, goals, communication style
- Cap of **two matches per person per fortnight**, each with a stated reason
- Intro happens in a public thread the person chose, or not at all
- Revoke, export, erase, all working end to end
- Operator CLI: one cohort, one digest, no dashboards

## Out of scope

- Feeds, timelines, follower graphs, likes
- Direct messages, cold intros, contact-detail reveals
- Group chats or team formation inside the product
- ML ranking, embeddings, "compatibility scores"
- Any lookup from an identifier to a person (blocked in code, not just by policy)

## Acceptance criteria

- [ ] 10 real people complete intake without being walked through it by hand
- [ ] Every profile holds a live consent receipt; revocation deletes derived signals in the same transaction
- [ ] At least 3 matches are acted on (a reply, a call, a shared repo)
- [ ] At least 2 pairs are still in contact after 14 days
- [ ] Operator can export and erase one person in under a minute
- [ ] `make test` green (162 tests) and no endpoint resolves an identifier to a person

The fourth criterion is the gate. The first three can be produced by enthusiasm
alone.

## Risks

- **Cold-start:** 10 profiles is not a network. Mitigation: start inside one
  community the operator is already in, not from advertising.
- **Politeness failure:** people accept matches and never reply, which reads as
  rejection. Mitigation: two-week window stated up front, and no notification when
  a match is declined by the other side.
- **Wrong-niche drift:** a cohort with nothing in common produces no work. Mitigation:
  pick one niche and stay in it for the whole cohort.

## Definition of done

Backlog of follow-on tickets exists and is ordered by what the cohort actually did,
not by what was easy to build.
