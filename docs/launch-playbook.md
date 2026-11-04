# Launch playbook

Four weeks, with gates. The point is to find out whether the need is real *before*
you have a platform full of people who never met anyone.

The failure mode this avoids: launching to 500 signups, getting 40 matches, and
discovering nobody agreed to a first session.

## Week 0 — before anyone else is involved

**Do this with 6 people you can talk to directly.**

- [ ] Run `make demo` and read the output until you understand every number
- [ ] Read `docs/threat-model.md` and decide whether the residual risks are
      acceptable for the population you have in mind
- [ ] Fill in the section of the intake form that describes *your* niche — if you
      are doing cybersecurity learners, say that instead of "projects"
- [ ] Deploy with a real `TANDEM_PEPPER` and a real `TANDEM_SMS_WEBHOOK`
- [ ] Decide your public position on the phone number: you are verifying a person,
      not identifying one. Write that sentence down and put it on the page.

**Gate:** you can explain, in one sentence, why a phone number is hashed and what
would happen if it were not. If you cannot, do not go to week 1.

## Week 1 — hand-made matches, no product

Six to ten people, recruited one at a time. No launch post.

Do it like this:

1. Ask each person one question: *"what are you building right now, and how many
   hours a week do you actually have for it?"*
2. Put them in the database by hand (`./cli/tandemctl seed` style, or the form).
3. Run `./cli/tandemctl match <name>` for each of them.
4. **Send the matches yourself, in a message, with the reasons included.**

```
Here's who I'd put you in front of:
Sam — 6h/week, working on local-first evidence tooling, wants a co-founder.
You both have python+security on the bench and similar availability.
Timezone is 1h apart. Worth 30 minutes?
```

This is the whole product, performed manually. If you cannot produce a
recommendation worth sending for six people in your own niche, the matching
engine will not save you.

**Gate:** at least 3 of 6 say "yes, I'd talk to them". If fewer, the problem is
the niche or the questions, not the code.

## Week 2 — self-serve, small

Open the form to 20–30 people from the communities in
`docs/discovery-playbook.md`. Keep verifying phones.

Watch, per person:
- did they finish the profile? (where did they drop?)
- did they verify? (the SMS is the biggest drop in the funnel)
- did they run matching?
- **did they act on a match?** (ask directly; there is no analytics and there
  should not be)

Expect a large drop at verification. That is the price of the gate. If 100% of
people verify, you are probably recruiting only people who already trust you.

**Gate:** ≥40% of completed profiles result in the person contacting someone.
Below that, matching is producing the wrong people and the reasons people gave
are your data. Read them.

## Week 3 — let them organize

- [ ] Create one small community space (Discord or a group chat) whose only
      premise is: post what you are building on Monday, ask for help on Thursday
- [ ] Post the prompt yourself, every week, without fail
- [ ] Run `make scout-live`, send **two** invites a day by hand, log opt-outs

**Gate:** someone posts in the community without being prompted, or two people
who met through Tandem ship something. Either one is the whole thesis.

## Week 4 — decide

Answer three questions honestly:

1. **Did pairs meet twice?** Not "did they match". Meet, then meet again.
2. **Did any pair form something durable** — a repo, a study schedule, a
   co-founder conversation?
3. **Would you be upset if it shut down tomorrow?** Ask the users, not yourself.

If 1 and 2 are yes and the number is small: good. That is a product. Keep going
with the same 30 people for another month rather than opening the doors.

If 1 is yes but 2 is no: the matches are pleasant but not *load-bearing*. Probably
the goal question is wrong for your niche — people say "co-founder" when they mean
"someone to talk to about this".

If 1 is no: stop. Either the niche has no need, or the intake questions are
collecting intentions instead of constraints.

## The numbers worth writing down

| metric | how | do not fake it |
| --- | --- | --- |
| profile completion | count rows in `people` with a goal | — |
| verification rate | distinct verified / distinct profiles | — |
| **first-session rate** | ask every matched pair, once | no tracking pixels, no "did you meet?" dark patterns |
| **second-session rate** | the only number that matters | this is retention for a friendship product |
| opt-out rate from scout | lines in `optout.txt` ÷ invites sent | if >10%, your invites are bad |

If you add analytics, add them aggregate-first: counts by stage, never per-person
behaviour, and never a per-invite tracking URL. The moment an invite link
identifies a person, the "no harvesting" claim is dead.

## What "launched" means here

Not a Product Hunt post. Launched means: **thirty people in one niche know what
this is, ten are using it, and three pairs are meeting regularly.**

Everything past that is growth, and growth is a different document.

## Things that will tempt you and should not

- **Removing phone verification to speed up signups.** It is the only thing
  keeping the match pool human. If the SMS is your biggest drop, fix the copy,
  not the gate.
- **Adding messaging.** The moment Tandem has its own inbox it becomes
  responsible for what happens in it. Let people take it elsewhere.
- **Automating the scout's invites.** 10× volume, 1/10th the response rate, and
  the first spam report ends the project.
- **Opening a second niche before the first works.** Two half-niches is how you
  get a platform with 40 profiles and no matches.
- **Ranking by "most active" instead of fit.** Activity is a proxy for nothing
  you care about. It will fill the top of the list with people who post.
