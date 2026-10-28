---
id: RS-446
title: Fleet Analysis counts from the ERP's finished tasks
type: bug
status: done
priority: P2
created: 2026-10-28
reporter: jinhu
branch: JinhuW/rs-446-fleet-analysis-funnel
pr: https://github.com/JinhuW/recycle_servres_erp/pull/980
version: 1.377.1
related: []
---

## Ask

> debug the issue why it is showing 0 here?

> yes, go ahead and fix them.

(The first message came with a screenshot of Facebook fleet ▸ Analysis, Today:
every stage of "From a search to an alert" at 0.)

## Context

The Analysis tab (`pages/desktop/fleet/FleetAnalysisTab.tsx`) took its funnel
and both daily charts from `coordinatorApi.reviewStats()`, which goes to
`/api/coordinator/stats/reviews`, then rs_console, then the coordinator's
`GET /v1/stats/reviews`. The coordinator counts only what workers POST to
it. The homelab workers that did that were retired (RS-418). The ERP fleet's
workers report no funnel counts to the coordinator. With `RS_ALERTS` unset
(`docs/superpowers/plans/2026-10-24-erp-fleet/HOSTS.md`) they are not even
handed its URL. Each search's counts land in `fleet_tasks.result` instead
(`{cards, opened, reviewed, alerted, seconds}`). The coordinator answered with
no days, so every stage read 0.

Prod on 2026-10-28 (UTC), read-only: 540 finished searches, 36,242 cards,
9,820 opened, 5,510 reviewed, 0 alerted. The day before: 435 / 22,560 / 6,711
/ 4,177 / 0.

## Acceptance criteria

- [x] `GET /api/fleet/stats/funnel?days=N` (manager-only, 1–92, default 14)
      returns one row per UTC day of finished `search` tasks: searches, cards,
      opened, reviewed, alerted. A missing or malformed counter counts as 0.
- [x] The Analysis funnel shows Search, Result cards, Open the listing, AI
      rating and Telegram alert from those rows over Today / 7 / 14 days. The
      title gate, keyword gate, new-to-us and coordinator stages show "—".
- [x] Pass rates are measured from the last counted stage, so the gaps into
      Open the listing, AI rating and Telegram alert carry a percentage.
- [x] Both daily charts read the same rows.
- [x] The stage settings, the prompt and Where the alerts came from still come
      from the coordinator.

## Out of scope

- Counting the title gate, keyword gate and new-to-us stages. The worker would
  have to add them to its task result. That is a worker release, which means
  recreating containers (Facebook logins), and needs the owner's yes.
- Alerts reading 0. The fleet runs with `RS_ALERTS` unset until cutover. That
  is a deliberate ops state, not a bug.
- The backend's `/api/coordinator/stats/reviews` proxy stays. It is one side of
  the coordinator contract. Only the frontend client was dropped.

## Notes

- The frontend's coordinator-stats remnants went with it: `reviewStats`,
  `ReviewStatsDay`, `FLOW_COUNTER`, `flowCounts`, and `reviewedToday`, which
  was already unused.
