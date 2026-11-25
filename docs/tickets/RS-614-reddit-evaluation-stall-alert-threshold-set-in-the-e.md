---
id: RS-614
title: Reddit evaluation stall alert, threshold set in the ERP
type: story
status: in-review
priority: P2
created: 2026-11-24
reporter: jinhu
branch: feat/reddit-eval-stall-alert
pr:
version: 1.481.0
related: [RS-612]
---

## Ask

> help me debug this alerts:
>
> ℹ️ Reddit: 1 warn/error line
> 1× evaluate · evaluation failed: OpenRouter HTTP 401: {"error":{"message":"User not found.","code":401}} — railway-worker

> also allow to set up this in the EPR ui

## Context

On 2026-11-24 at 06:16 UTC the tracker's OpenRouter key was replaced with one
OpenRouter rejects (`401 User not found`). Every evaluation failed after that.
By the next evening 301 posts had used up their attempts as `failed`, and no
lead had been judged for about 20 hours.

The only signal was the per-minute Errors digest, one "1 warn/error line" at
a time. The Workers page ("evaluate failing", after 3 bad iterations in a
row) never fired. An iteration that finds nothing to claim counts as clean,
so the evaluate loop's `consecutiveFailures` went back to 0 between posts.

The fix is an alert that measures the outcome rather than the loop: no post
judged for N minutes while posts are waiting. N is set on the ERP's Reddit
page, as the repo's rule asks for any tunable.

## Acceptance criteria

- [x] The tracker has a setting `eval_stall_alert_min`, an integer from 0 to
      1440, seeded at 60. 0 turns the alert off.
- [x] The watch pages Reddit · Workers with "Reddit evaluation stalled" when a
      post discovered after the newest judged post has waited longer than
      the threshold. The alert names how many are waiting and the evaluate
      loop's last error.
- [x] It resolves ("Reddit evaluation resumed") once a newer post is judged,
      the waiting posts are gone, or the alert is turned off.
- [x] Monitors ▸ Reddit ▸ Workflow ▸ Evaluate shows the threshold ("Off" at 0)
      and a manager can edit it there. The ERP proxy opens only that one key.

## Out of scope

- Requeueing the posts that failed in the outage: that is a one-off operation.
- Changing the per-minute Errors digest or the failing-loop rule.

## Notes

Debug note: `trackers/reddit/docs/debug-notes/dead-llm-key-never-paged.md`.

The ordering uses `discovered_at`, because posts have no evaluated-at column.
A post discovered after the newest judged one, and still `new` or `failed`, is
waiting. One post that always errors is outrun by the next post that gets
judged, so it never raises the alert by itself.
