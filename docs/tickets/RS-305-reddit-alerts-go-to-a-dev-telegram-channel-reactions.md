---
id: RS-305
title: Reddit alerts go to a dev Telegram channel, reactions count as leads, and every prompt version is scored
type: story
status: in-review
priority: P2
created: 2026-10-18
reporter: jinhu
branch: reddit-worker-results-flow
pr: "#753"
version: n/a — trackers/reddit (no release process); deployed 2026-10-19 as image 04f5e24a
related: []
---

## Ask

> I would like to evaluate the Prompt for filtering the alerts.
> so i hope you can think of an approach to send alerts to an develop telegram channel.
>
> also you should also pull the reaction from your post if see ow many reaction you received.it could called lead, more lead mean more success rate.
> I hope our prompt can keep optimized with more accurate data to prove.

## Context

The Reddit tracker judges about 300 posts a day with one OpenRouter call each.
About 15 a day reach the buyers' Telegram supergroup (*Recycle Servers - Reddit
Alerts*, 9 members, bot is admin). Nothing records which prompt produced a
verdict or whether anyone acted on the alert, so a prompt change can only be
judged by guessing. Reactions have never been captured: the bot never asked
for `message_reaction` updates, and Telegram keeps no reaction history for
bots.

A read-only look at prod on 2026-10-18 found the live prompt in poor shape.
`trackers/reddit/docs/prompt-evaluations/2026-10-18-baseline.md` has the
numbers and queries:

- `eval_prompt` and the one enabled rule are two full prompts that contradict
  each other. One says any quantity of SSDs; the other says at least 7 target
  items. `composeEvalPrompt` concatenates them.
- 22 of the 40 most recent alerts break the prompt's own rules:
  - 1–4 SSDs called "bulk";
  - HDDs counted as SSDs;
  - non-ECC gaming kits called ECC.
- The response schema asks for the verdict before the reasoning. One alert's
  reasoning says "below the required minimum of 7" and its verdict is still
  true.
- The 2026-09-13 prompt edit cut the target rate from about 7.2% to about
  4.9%. There is no way to tell whether that made the alerts better.

The Facebook tracker already does this kind of tracking: its "alert hit rate"
in `trackers/facebook/rs_coordinator/` keeps a sent-message ledger, a raw
reaction log, and current state per user. This ticket brings the same model to
Reddit.

## Acceptance criteria

- [x] Every live verdict records the prompt version (model + full composed
      prompt) that produced it.
- [x] Every buyer alert's Telegram message id is recorded against its post.
- [x] With `telegram_dev_chat_ids` set, every live alert is also sent to the
      dev chat with the model's reasoning and prompt version.
- [x] With `candidate_eval_prompt` set:
  - every post is also judged by the candidate;
  - posts only the candidate flags go to the dev chat alone, never to the
    buyers;
  - each dev message says which prompt flagged it.
- [x] The api role pulls reactions on alert messages in buyer and dev chats,
      from groups (per user) and channels (anonymous counts). It survives a
      restart without losing or replaying its cursor.
- [x] An alert with any reaction other than 👎 counts as a lead; 👎 counts as
      not a lead.
- [x] `GET /api/prompt-stats`:
  - shows per version: evaluated, targets, buyer leads and lead rate, dev
    leads and not-leads;
  - shows the candidate-versus-live comparison on the same posts;
  - counts reactions on messages it has no record of.
- [x] `POST /api/prompt-candidate/promote` makes the candidate live, disables
      the rules, and keeps its version id, so its numbers carry on.
- [x] The baseline evaluation and the first candidate prompt are written up
      in `trackers/reddit/docs/prompt-evaluations/`.

## Out of scope

- **A prompt-stats card on the ERP's Monitors ▸ Reddit page.** It needs the
  contract change described in the root `AGENTS.md`, and is worth doing once
  real lead data exists.
- **Reordering the response schema so reasoning comes before the verdict.**
  It changes every verdict at once, so it should run as its own measured
  experiment.
- **Cross-post dedup.** The same listing posted to homelabsales and
  hardwareswap alerts twice, because the dedup key is the Reddit id.
- **Backfilling reactions on alerts sent before this work.** Telegram has no
  API for it.
- **Sampling rejected posts into the dev chat** to label missed leads.

## Notes

- `getUpdates` is exclusive per bot token. Two checks came first:
  - The Reddit bot's token differs from the Facebook coordinator's
    (compared by hash).
  - No webhook is set.

  The consumer runs only in the single api process, and only with the
  Telegram transport.
- Candidate-only reviews go out from the evaluate loop while the post is
  still claimed. They never enter the buyers' queue, so a candidate can never
  message buyers.
- Deployed on 2026-10-19 at about 00:55 UTC:
  - the Railway `api`, now with `ALERT_TRANSPORT=telegram`; its reactions loop
    is running;
  - the Railway `worker`;
  - all five OCI VMs, on image `04f5e24a`.

  Migration 0003 applied, and prompt version 1 is the live prompt.
- The amd64 half of the image build first failed on the Mac's emulator; see
  `trackers/reddit/docs/debug-notes/amd64-image-build-crashes-node.md`.
- Still to do, on the user's side:
  - top up OpenRouter, then requeue the outage's `failed` posts;
  - create the dev chat with the bot as an admin, and set
    `telegram_dev_chat_ids`;
  - start candidate 1.

  The ticket moves to done once a real reaction shows up in
  `GET /api/prompt-stats`.
- While verifying, a prod outage turned up: the OpenRouter key ran out of
  credit around 20:00 UTC on 2026-10-18. Every evaluation since then fails
  with HTTP 402, and the posts are being parked as `failed`. The 402 asks to
  reserve 16384 output tokens, because `evaluatePost` sends no `max_tokens`.
  A cap would let a low balance last a little longer, but would not fix an
  empty one.
