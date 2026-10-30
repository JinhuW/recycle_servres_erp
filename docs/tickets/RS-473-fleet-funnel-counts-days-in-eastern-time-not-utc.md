---
id: RS-473
title: Fleet funnel counts days in Eastern time, not UTC
type: story
status: done
priority: P2
created: 2026-10-30
reporter: jinhu
branch: JinhuW/fiddler
pr: 1016
version: 1.390.0
related: []
---

## Ask

> pls verify if the alerts send match the actual amount we received in the telegram.
> [screenshot: Analysis funnel, "today (UTC)", Telegram alert 13]

> cuz i only saw 7 instead of 13

> Pls use the local time instead of UTC time to decied the range.

## Context

The 13 was right for the UTC day. On 2026-10-30 every one of the 13 search
tasks reporting `alerted` matched a delivered row in the coordinator's
`alert_messages` (chat -1004498115958, ids 1571–1583). Four of them went out
between 8:12 and 9:45 PM Eastern on Oct 29: "today" in UTC, yesterday in the
chat. Nine went out after Eastern midnight, 3 in the medium topic and 6 in low.

`funnelDays` (`apps/backend/src/fleet/tasks.ts`) bucketed finished searches by
`done_at` in UTC, and the Analysis tab (`funnelCounts`, `daySeries` in
`fleetBoard.ts`) picked its Today / 7 / 14 windows by UTC date. Every clock
on the fleet pages already reads in the office zone, `FLEET_TZ`
(America/New_York), so "local" here is that zone, not the browser's.

## Acceptance criteria

- [x] `/api/fleet/stats/funnel` buckets finished searches by their Eastern
      calendar day, and the window starts at Eastern midnight `days-1` days
      ago, across a DST change too.
- [x] The Analysis tab's Today / 7 / 14 ranges and both 14-day charts use
      Eastern days.
- [x] The range chip, funnel subtitles and chart labels say ET, not UTC (en + zh).
- [x] On prod, Today's Telegram alert count equals the `alert_messages` rows
      sent since Eastern midnight.

## Out of scope

The minutes budget stays per UTC day (`fleetMinutesNote`, `budget_minutes`,
`utcDayStart`, `averageTaskSeconds`): the scheduler counts it that way.
Per-viewer browser time zones.
