---
id: RS-450
title: Count the title, keyword and new-to-us stages and show what passed the model
type: story
status: backlog
priority: P2
created: 2026-10-28
reporter: jinhu
branch: JinhuW/gar-2
pr:
version:
related: []
---

## Ask

> There are two data point is missing. check if we need this or better data to analysis.

> yes.

(The second line answers: "Should I file a ticket and build it, and should
'Passed the model' replace the Coordinator stage?" It came with a screenshot
of Fleet → Analysis where Title gate, Keyword gate, New to us and Coordinator
read "not counted yet", and AI rating 5,726 led to 0 alerts.)

## Context

Since RS-446 (v1.377.1) the Analysis funnel sums `fleet_tasks.result` per UTC
day (`funnelDays()` in `apps/backend/src/fleet/tasks.ts`). The worker counts
every stage per city (`CityRun.counts` in the vendored monitor), but
`_record_task_result()` reported only cards, opened, reviewed and alerted, so
three stages had nothing to sum.

The Coordinator stage was the old coordinator's ingest count. ERP-mode
workers run with alerts off unless the claim env carries `RS_ALERTS=on`; a
listing that clears the score and unit gates is then logged `WITHHELD (fleet
alerts off)` and counted nowhere. The page read that as "the model drops 100%
of what it reads", which may be false. "Passed the model" is the count that
answers it.

## Acceptance criteria

- [ ] A fleet task's result carries `title_pass`, `keyword_pass`, `fresh`, `passed` and `withheld` beside the existing four keys.
- [ ] `passed` counts a fresh verdict that clears both the minimum-units gate and the score threshold; `withheld` the subset held back because fleet alerts are off. A cached verdict counts in neither, the same rule `reviewed` follows.
- [ ] `GET /api/fleet/stats/funnel` returns these five sums per day; a day where no task reported a key returns `null` for it, not 0.
- [ ] Analysis shows numbers for Title gate, Keyword gate and New to us; a stage stays "not counted yet" while every day in the range is `null`.
- [ ] The Coordinator stage becomes **Passed the model**, between AI rating and Telegram alert, showing the withheld count when there is one; its panel explains withholding, and the claim/de-duplication text moves to the Telegram alert stage.
- [ ] The headline names what passed the model and what was held back, and no longer claims the model drops 100% when listings were only withheld.
- [ ] `passed` and `withheld` stay off the coordinator's `/v1/stats/reviews` report.

## Out of scope

- Restarting or redeploying workers: the counts arrive as workers run the new image on their normal schedule.
- Turning fleet alerts on.
- Backfilling old tasks, which carry no such counts.

