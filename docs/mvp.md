# The MVP

The point of the MVP is not to prove the matcher works. Ranking people is the easy
part, and it is already done. The point is to prove the **environment** works: that
a small group of adults, given one shared activity and a reason to return, actually
do return.

That is the whole thesis, in the author's words: friendship is repeated exposure
plus shared activity plus gradual vulnerability, and adults have to manufacture the
first two themselves.

## Scope

One niche. For this repository the default niche is **AI, security, and tech
builders**, because the operator can judge the work and speak the language. Pick a
niche you can personally evaluate; a matching platform whose operator cannot tell
good work from confident work is just a directory with better typography.

| in the MVP | deliberately out |
| --- | --- |
| one profile form: name, location, interests, current project, hours/week, looking-for | multiple profile types, teams, orgs |
| opt-in intake page, no account required to fill it in | feeds, timelines, follower graphs |
| phone-verified consent receipt for the one identifier that matters | a password, an SSO, a directory |
| matching on shared interests, availability, goals, comm style | ML ranking, embeddings, "AI compatibility" |
| two matches per person per two weeks, with reasons | infinite results, browsing strangers |
| a public thread to reply under, or nothing | direct messages, cold intros, contact reveals |
| revoke, export, erase | analytics dashboards tracking people |

The cap of **two matches per fortnight** is a product decision, not a technical
limit. Scarcity is what turns a list into an introduction, and it is what keeps the
first cohort from being overwhelmed by options they will not act on.

## What the person actually sees

1. The six fields. No "about me", no photos, no follower count.
2. One verification: a phone number, or a linked account they own.
3. A wait. Two weeks at most, and the copy says so.
4. One or two matches, each with a reason ("you are both building evals tooling,
   both free Tuesday evenings").
5. A public thread to reply under, if they want the intro. Never a DM.

## Acceptance criteria for the MVP

- [ ] Ten real people complete intake without being walked through it by hand
- [ ] Every profile has a live consent receipt, and revocation works end to end
- [ ] At least three matches are acted on (a reply, a call, a shared repo)
- [ ] At least two pairs are still in contact after fourteen days
- [ ] The operator can export and erase one person in under a minute
- [ ] Nothing in the system can be used to look up a person by identifier

The fourth item is the real gate. The first three can be faked by enthusiasm; the
fourth cannot.

## How to run it before writing more code

The cheapest test is not a deployment, it is a room. Run the cohort by hand first:

1. Stand up the intake form (`make dev`), post it in one community you are already
   part of, and watch whether people finish the form without asking questions.
2. Match the first cohort manually, with the paper rule above: two per fortnight,
   always with a reason.
3. Only then turn on the matcher, and compare its ranking to yours.

If step 1 produces ten completed profiles and step 3 mostly agrees with you, the
product is real and the engine is fine. If step 1 stalls, the problem is the intake
copy or the niche, and no amount of matching work will find it.
