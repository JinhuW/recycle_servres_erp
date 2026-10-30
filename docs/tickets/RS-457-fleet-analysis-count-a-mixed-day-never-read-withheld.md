---
id: RS-457
title: Fleet Analysis: count a mixed day, never read withheld as rejected
type: bug
status: done
priority: P2
created: 2026-10-29
reporter: jinhu
branch: JinhuW/rs-457-fleet-funnel-mixed-day
pr: 999
version: 1.380.2
related: [RS-450, RS-452, RS-455]
---

## Ask

> [screenshot of the fleet Analysis tab: Title gate, Keyword gate, New to us and Passed the model "not counted yet", Telegram alert 0, "the model drops 100% of what it reads"]
> Debug this and why it still does not have any data?

> yes. fix them.

## Context

On 2026-10-29 (prod, read-only):

- The fleet ran worker 0.14.10 until the 0.15.0 release began at 21:00 UTC.
  Only 0.14.18 and later report `title_pass`, `keyword_pass`, `fresh`,
  `passed` and `withheld` in a task result (RS-450). 376 of the day's 377
  searches lacked them. `funnelDays` (`apps/backend/src/fleet/tasks.ts`, RS-452)
  nulled a stage for the whole day when any search with cards lacked it, so the
  one 0.15.0 search's counts (title 48, passed 1) were thrown away. Any older
  worker that searches does this again: a parked worker freed later starts on
  `FLEET_IMAGE_WORKER`, still 0.14.10.
- Those old workers booted before `RS_ALERTS=on`, so they withheld all 91
  passes (42 listings). The host-side sender delivered 23 and skipped 19 as
  duplicates; none of that reaches `fleet_tasks`, so the funnel showed 0 alerts.
  Workers on 0.15.0 boot with alerts on.
- `funnelHeadline` (`apps/frontend/src/pages/desktop/fleet/fleetBoard.ts`) read
  the model's drop from alerts when `passed` was not counted, so withheld
  alerts read as rejections: "drops 100%", where the model passed about 2%
  (91 of 4,428 ratings in OpenSearch).
- Separately, the fleet stopped searching at about 15:50 UTC because every
  healthy account but one had used its 360-minute daily budget. That is by
  design.

## Acceptance criteria

- [x] `GET /api/fleet/stats/funnel` sums each later stage over the searches
      that reported it, null only when none did, and returns per day
      `counted` (searches with cards that reported the later stages) and
      `carded` (searches with cards).
- [x] A day with `counted < carded` marks the later stages partial (star, no
      rate against a whole stage, no headline ratio from them).
- [x] The footnote says the stages were counted from N of M searches in the
      range.
- [x] The headline never derives the model's drop from alerts: without a
      whole `passed` count there is no "model drops" clause.

## Out of scope

- Counting the host sender's alerts into the funnel. It is a stopgap until
  RS-455, and moot once every worker boots with alerts on.
- Bumping `FLEET_IMAGE_WORKER` to 0.15.0: an ops change for the owner.

## Notes

Plan: `~/.claude/plans/sparkling-honking-crane.md` (session-local).
