---
id: RS-600
title: Reddit outreach guardrails: chat-first DMs, daily cap, do-not-contact
type: story
status: in-progress
priority: P2
created: 2026-11-20
reporter: jinhu
branch: feat/reddit-outreach
pr:
version:
related: [RS-477]
---

## Ask

> help me review the redditsapi doc and see how it can DM to certain subreddits user and figure out what we need to preapre.

> Pls create an detailed implementation plan, then start the implementation

## Context

The review (plan: `docs/superpowers/plans/2026-11-20-reddit-outreach.md`)
found that sending DMs through Reddit's API is closed to us. The Developer
Terms need written approval for business use, and new app requests closed on
2026-10-31. Public API access ends in March 2027, and private messages became
Reddit Chat, which has no official API. So purchasers keep sending every
message by hand, as RS-477 set up. This ticket adds guardrails for doing that
at volume:

- the send flow targets Chat;
- first messages are capped per purchaser per day;
- a seller who says no is never messaged again;
- the subreddits' comment-first rule is shown.

## Acceptance criteria

- [ ] The lead drawer's primary send action copies the message and opens `chat.reddit.com/user/<name>`; the old compose page stays as a secondary link.
- [ ] A purchaser can mark at most `REDDIT_LEAD_DAILY_FIRST_DMS` (15) first DMs per local day. The next one gets 429 `rlDailyCap`, and the drawer shows the count and disables sending at the cap. Follow-up DMs are not capped.
- [ ] A lead can be closed as **Asked not to be contacted** (`optout`). That stamp survives release and re-import, claim answers 409 `rlOptedOut`, and the Pool hides the seller. Only a manager can reopen it.
- [ ] When a lead has a latest sale post, the writer asks the purchaser to comment on it first and links it.
- [ ] First-contact templates end with an opt-out line.
- [ ] Every new write goes to the append-only ledger.

## Out of scope

- Sending messages from the ERP or by automation, through the API or a browser. Reddit's terms rule it out for us; see the plan.
- The Reddit tracker's data source after RSS was retired on 2026-11-13 (plan, Workstream B). It needs the owner's choice and gets its own ticket.
- `reddit_marketing`'s DM step (plan, Workstream C).

## Notes

- The cap is a constant, not a setting, until the owner wants to tune it.
