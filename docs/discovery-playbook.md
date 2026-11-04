# Discovery playbook

Where the people are, what each place actually exposes, and how to invite someone
without being a creep.

The ordering principle: **go where the work is already public.** A community
where people post what they are building is discoverable without surveillance. A
community where people only chat socially is not, and trying to make it so is how
this idea turns bad.

## The amendment: public groups, not private ones

Earlier drafts treated "group" as a category to avoid. That was too blunt. The
real line is not *group vs individual*, it is **choosing to be readable**:

| surface | readable by a stranger without joining | in scope |
| --- | --- | --- |
| open read endpoint (HN, DEV, GitHub issues, Bluesky) | yes | ✅ `public_surface` |
| public group that publishes its own join link **and** a readable page | yes | ✅ `public_group` |
| group where you must be admitted to read anything | no | ❌ `invite_only` |
| members-only channel, paid group, private DM | no | ❌ `private_channel` |
| a group's member list, join requests, or reactions | — | ❌ `group_member_list` |

So a public Telegram channel with a web preview is in scope: it publishes its own
way in, and anyone with a browser can read it. A group whose only access is an
invite someone forwarded to you is not: the people posting chose a room with a
door, and being handed a key does not make it a public square.

Three rules make this enforceable rather than aspirational
(`services/scout/tandem_scout/policy.py`):

1. Every source declares a visibility class, and `assert_surface()` refuses any
   name in `PRIVATE_SURFACES`.
2. `assert_group_admitted()` requires a **public join link** and content that is
   **readable without joining**, and refuses any use of member data.
3. Group observations are flagged as describing **the group, not a person**
   (`policy.produces_individuals`). They can only ever feed the community list.
   You cannot invite a channel, and a channel's audience is not a lead list.

What this changes in practice:

- **Telegram public channels** are now a source (new adapter, `--channels`).
- **Discord** stays out, but for a precise reason: even a public server requires
  joining to read history, so `assert_group_admitted` refuses it. If Discord ever
  ships a public read surface, the adapter is one class.
- **Facebook Groups** stay out: the Graph API has had no group-content access
  since 2018, and public groups are login-walled.
- **Reddit** stays out by default, for the OAuth reason given below.

Nothing about private groups becomes reachable. The opt-out file, the caps, and
the public-thread-only invite rule are unchanged.

## The map

### Professional / startup

| place | what it exposes | usable by the scout | note |
| --- | --- | --- | --- |
| LinkedIn | profiles, posts, real names | **no** | No meaningful public topic search; scraping violates terms and gets you banned. Manual only. |
| Wellfound | startup roles, founding teams | no | Read it to understand demand, not to source people. |
| Lunchclub | algorithmic introductions | no | The closest existing product to this idea. Study the onboarding, not the data. |
| ADPList | mentors with listed availability | semi | Public mentor profiles are *explicitly offering help*. Best source of mentors for the niche. Manual outreach. |

**Use these for**: understanding the vocabulary people use to ask for partners,
and for finding mentors who have already opted into being contacted.

### Tech / builders — the scout's territory

| place | what it exposes | scout source | note |
| --- | --- | --- | --- |
| Hacker News | every story and comment, via Algolia | ✅ `hackernews` | Best signal-to-noise for "what are you building". `Ask HN` / `Show HN` are gold. |
| GitHub | issues, PRs, discussions per repo | ✅ `github` | The strongest competence proxy. Search issues by topic; the person already wrote a paragraph about the problem. |
| DEV Community | articles with tags | ✅ `devto` | Public tag search, generous API. Good for learners and writeups. |
| Bluesky | posts, public search endpoint | ✅ `bluesky` | Small but technical population. Proof-post linking works well. |
| Hacker News "Who wants to be hired" | monthly thread | manual | Read once a month. People state exactly what they want. |
| Indie Hackers | products, milestones, forums | manual | Public but no clean topic search. Good for "shipping solo, wants a partner". |
| Dev.to comments, r/… | see Reddit below | — | — |
| Slack communities | invite-only | **never** | Members joined a private space. Reading it to source people violates the point of an invite. |

### Local / in-person

| place | what it exposes | note |
| --- | --- | --- |
| Meetup | groups and public event listings | Find the group; attend the event. Do not scrape attendees. |
| Eventbrite | public events | Same. |
| Hackathons (university, public) | teams forming in the open | The single highest-conversion channel. People leave with a team. |
| Local library / coworking boards | — | Physical. Surprisingly effective for the "accountability partner" goal. |

### Interest-based

| place | what it exposes | note |
| --- | --- | --- |
| Reddit | public posts, but not to non-browsers | Unauthenticated JSON returns 403. Doing it properly needs an OAuth app plus API terms. **Disabled by default** in `policy.py` with that reason in code. |
| Discord servers | nothing readable without joining | A public server still needs membership to read history, so it fails `assert_group_admitted`. **Refused, not merely absent.** |
| Facebook Groups | nothing, to a third party | Graph API has had no group-content access since 2018; public groups are login-walled. **Refused.** |
| Telegram public channels | the public web preview at `t.me/s/<name>` | ✅ In scope as a `public_group`. Read with `--channels`, attributed to the channel, never to individuals. |
| Specialised forums (security, AI, fitness) | varies | If a forum has a public search, it can be a source. Add an adapter; respect robots and rate limits. |

### The niche, concretely

For AI builders and security learners, in priority order:

1. **GitHub issues** in 20–30 repos you actually use. Highest signal: someone
   writing a paragraph about a bug in a tool you both care about.
2. **Hacker News** `Ask HN: who is working on X` and `Show HN`.
3. **Bluesky / Mastodon** for the security-research crowd.
4. **Local tech meetups and public hackathons.** Slowest, converts best.
5. **Indie Hackers** for the solo-founder-wants-a-partner case.

## What "scanning" can and cannot mean

Can:
- query a public search endpoint for a topic
- read public posts by public handles
- note *who wrote about this topic recently, more than once*

Cannot, in this codebase:
- find someone's phone number or email
- translate a handle on one platform to a handle on another
- read a community that requires joining to read at all
- enumerate a group's members, join requests, or reactions
- treat a public group's audience as a list of people to invite
- send anything automatically

The second one deserves emphasis: **no cross-platform identity resolution.** If
`realtimearcher` on HN and `realtimearcher` on GitHub are the same human, Tandem
does not know and does not merge them. Merging is the step that turns a set of
public posts into a dossier.

## Reading a public group

```bash
# one or more public channels, named by hand. A group is chosen, never discovered.
cd services/scout
python3 -m tandem_scout --sources telegram_public --channels examplebuilders,anotherchannel --live
```

Output goes to **`groups.json`** and the "Public groups" section of `digest.md`:
posts per week, what the group talks about, and its own join link. There is no
draft and no invite, because the unit is a community you might join or mention,
not a person you might interrupt.

A channel with no public preview is refused with
`"... has no public web preview, so it is not a public group by our definition"`.
That is the amendment working: no preview means no public, and no public means no
reading.

## The invitation

Rules that are not negotiable, and are enforced in
`services/scout/tandem_scout/queue.py`:

- **Public thread only.** Reply under the post that surfaced them.
- **One per person.** Ever, from a given run.
- **One or two per day, by hand.** The digest says this at the top.
- **Say what you are, name the opt-out, and mean it.**
- **Never in a DM.** If they reply and move to DM themselves, that is their
  choice.

The generated draft:

```
Hi <handle> — your <interest> post on <source> (<link>) is the kind of thing I'm
looking for.
I'm building Tandem: a small opt-in place to find project partners for exactly
that kind of work. No phone number needed, and it publishes what it stores
before you sign anything: <invite url>
If it's not for you, ignore this and I won't follow up.
```

Why it is shaped like that:

- it names the *specific post*, so it is obviously not a blast
- it says what the product is in one line
- it makes an unusual promise ("publishes what it stores") that is true and
  checkable
- it gives an out, and the out is honoured by a human, not a button

When someone ignores it, that is not a lead to follow up on. When someone asks
you to stop, add the handle to `data/scout/optout.txt`. The opt-out check runs
before any scoring, so they will never surface again:

```
# data/scout/optout.txt — wins over everything
hackernews:realtimearcher
someotherhandle          # bare handle = opt out everywhere
```

## The non-scout channels, which are better

Automated discovery is the *fallback*. In rough order of conversion:

1. **Be publicly useful in one niche for four weeks.** Answer questions in the
   communities on the map. People arrive at Tandem already knowing who you are.
   This outperforms every scraper ever written and costs nothing but attention.
2. **Public hackathons.** Teams form in the open. Invite the person you just
   built a thing with.
3. **A single-thread Discord or Slack of your own**, seeded with 10–20 people,
   where the whole premise is "post what you're building on Monday". If people
   keep coming back, you have validated the need before writing more code.
4. **The scout**, for the long tail: people you would never otherwise encounter
   because they post at 2am in a thread nobody reads.

## Weekly cadence that stays human

| day | activity | time |
| --- | --- | --- |
| Mon | post the "what are you building" prompt in your own community | 10 min |
| Tue | `make scout-live`, read the digest, send **two** replies | 20 min |
| Wed | answer three questions in the niche, no pitch | 20 min |
| Thu | follow up with anyone who replied to anything, ever | 15 min |
| Fri | two more scout replies; add opt-outs; note what converts | 20 min |

Two hours a week. If that does not produce a handful of conversations in a month,
the niche is wrong, not the tool.

## Honest limitations

- The scout cannot see Discord, Facebook, LinkedIn, or Slack. Anyone who tells you
  they can is either scraping in violation of terms or already banned.
- Public posting frequency is a weak proxy for "would be good to work with". It
  measures visibility, not reliability, and it will over-index on people who post.
- The people most worth meeting are often the least visible. The manual channels
  exist for exactly them.
