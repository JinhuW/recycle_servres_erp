---
id: RS-413
title: Reddit tracker: cross-post dedup, any-emoji feedback, PM tracer and Analytics tab
type: story
status: done
priority: P2
created: 2026-10-26
reporter: jinhu
branch: JinhuW/reddit-analytics-pm-tracer
pr: 928
version: 1.362.0
related: []
---

## Ask

> 1. fix the cross-post duplicate alerts too.
> 2. Not only 👍, but also an any emoji. beside 👎 as a goo catch.
> 3. Add an analysis tab for tracking the performance. I would like to know some basic data over the past 24 hours / 7 day/ 30 days.
> I don't have much idea here, think of any good data point here for me.
> 4.
> Theere is one critical for a good evaluate is that how many PM reply for a subreddits. more PM. means it is more valuable.
> Assign one worker to go back and trace all post in past one day and calaulate the PM comments count.
> Count all post has 5 PM but not any emoji on the post as missing. use this as evaluate critical for prompt as well. (put in the anaylysi tab)

## Context

Follow-up to RS-404, which made the live prompt (v69) alert only on bulk
Samsung, SK Hynix and Micron RAM.

- **Cross-posts alert twice.** The same listing in r/homelabsales and
  r/hardwareswap has two reddit ids, and the only dedup is the `reddit_id`
  primary key. The Atom feed carries no `crosspost_parent`, and most
  cross-posts are posted again by hand anyway.
- **Feedback already counts any emoji.** The `message_labels` view
  (`0003_prompt_feedback.sql`) treats every reaction except 👎 as positive.
  Only the alert footer still asks for 👍.
- **There is no performance view.** The ERP tracker page has Fleet, Workflow
  and Prompts tabs, and the stats it shows cover the last 24 h only.
- **PMs are the demand signal.** Nothing fetches comments today, and Reddit
  blocks anonymous `.json`. The per-post Atom feed
  (`/r/<sub>/comments/<id>/.rss`) does answer anonymously, and it carries
  each comment's author and body.

Owner decisions, made in planning:

- Only posts that mention memory count toward "missing". Other high-PM posts
  get their own list.
- A cross-post gets one alert and then silence. The second copy is still
  judged, so the prompt stats stay fair.

## Acceptance criteria

- [x] A cross-posted listing sends one buyer alert. The second copy gets
      status `duplicate` with `duplicate_of` set.
- [x] The alert footer asks for any emoji as a good catch and 👎 as not
      useful. Labels still count every non-👎 reaction as good.
- [x] Exactly one worker runs the PM tracer (`COMMENT_TRACER=on` plus a DB
      lease). Each post is traced once it is 24 h old, up to 8 days back, and
      gets `comment_count` and `pm_count`.
- [x] `GET /api/analytics?window=24h|7d|30d` returns volume, feedback, speed,
      PM demand, per-subreddit and per-prompt-version metrics. The ERP proxies
      it and shows it on `/tracker/analytics`.
- [x] Missing means a memory post with `pm_count ≥ 5` and no non-👎 reaction
      on a buyer alert. It is shown per prompt version (PM recall) and per
      subreddit.

## Out of scope

- Editing the first alert to link to the cross-post.
- Feeding PM counts into the prompt itself.
- Reddit OAuth.

## Notes

Plan: one PR covering the tracker, the ERP proxy route and the frontend tab.
The tracker ships first and stays backward-compatible.

- **Duplicate rule, calibrated on prod.** The calibration set was 380
  same-author post pairs within 72 h over 30 days where at least one was a
  target.
  - Body similarity alone paired one EU seller's separate RAM lots, which
    share a template body, so a body match counts only across subreddits.
  - A title match must also agree on model numbers, so OptiPlex 7070 vs
    5000 stays two listings.
  - Different module counts or makers always mean two listings.
  - Replaying the last 30 days of alerts, 71 of 480 would have been held
    back as repeats.
- **The tracer reads the comment Atom feed** (`<permalink>.rss?limit=500`),
  anonymous like the post feed. The PM count matched a hand count on four
  real threads (4, 10, 11 and 20 buyers). It skips `hwsbot`, AutoModerator
  and the seller's "Replied" comments.
- **The 24 h window has no traced posts**, since tracing waits a day. So
  demand figures cover the same span shifted back a day (`demandRange`).
- **No ERP `LoopName` change.** The ERP's `LoopName` is the funnel's three
  stages, so `trace` was added only on the tracker side (heartbeat loops).
  The ERP type reads `loops` as a partial record.
