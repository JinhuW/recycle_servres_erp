---
id: RS-416
title: ERP-fleet worker page matches the homelab worker page
type: story
status: backlog
priority: P2
created: 2026-10-26
reporter: jinhu
branch: fleet/worker-page-parity
pr:
version:
related: [RS-394, RS-412, RS-415]
---

## Ask

> fix the UI inconsistency. The new worker should have the same worker detail page.

## Context

`/fleet/worker/<id>` served two pages. A homelab (coordinator) worker got
`FleetWorker.tsx`: a credential card with a status stripe, a stat row (alerts,
last search, last listing, errors, open checkpoints), a dozen rows, actions,
then Open checkpoints, Accounts used, City log and a History column. An
ERP-fleet worker (`worker-60-14-1`) got `FleetWorkerPage` in
`fleet/FleetWorkerSwitch.tsx`: state, heartbeat, account number, version and
task, plus Watch. The data for a fuller page existed across `fleet_workers`,
`fleet_slots`, `fb_pool_accounts`, `fleet_proxies`, `fleet_tasks` and
`fleet_task_events` (CONTRACTS.md §4, §5, §7), but no route gathered it.

## Acceptance criteria

- [x] An ERP-fleet worker's page uses the same layout and components as the
      homelab page (shared `fleet/workerDetail.tsx`, not a copy).
- [x] One manager-only read, `GET /api/fleet/workers/:id`, answers the worker,
      its slot (held, else its account's), pool account with stored secret
      kinds and no value, the listed proxy without its URL, cities, 7-day
      stats, the 24-hour task log, task events and the release version; 404
      for an unknown id.
- [x] Rows without a fleet source (Last listing, Session file) read "—".
- [x] A worker parked on a wall or lost session shows it under Open checkpoints.
- [x] Fleet actions: Watch browser (ERP relay), Park / Unpark, Remove from
      fleet, Search a city now, Release quarantine; homelab-only actions hidden.
- [x] Accounts used, City log and History render for a fleet worker.
- [x] Vitest for the mapping helpers, smoke renders of both pages, backend tests.

## Out of scope

- Mark resolved for a fleet checkpoint: the fleet keeps no checkpoint record;
  the worker lifts its parked state itself once the page is clear.
- Last listing per worker: fleet task results carry no listing timestamp.
- A screenshot of the wall: fleet workers upload none.

## Notes

Pure mapping in `fleet/fleetWorkerView.ts` (status bucket, checkpoint, chips,
task log as coordinator city visits, history). Released tasks lose their
`worker_id`, so errors and history are read from `fleet_task_events`, which
keep it. Visual check: vite with mocked API answers from the test fixtures,
both pages screenshotted side by side.
