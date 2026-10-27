---
id: RS-436
title: Fleet tab shows two worker statuses: Healthy and Parked
type: story
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/hydroid
pr: 966
version: 1.373.0
related: [RS-431, RS-418]
---

## Ask

> Simplify the status of workers.
>
> Only healthy or Parked.
>
> if any session expired, then it will move to parked.

## Context

The Fleet tab's worker table (`pages/desktop/fleet/FleetAccountsTab.tsx`) had
a legend of six kinds: All workers, Healthy, Degraded, Replacing, Parked,
Offline, and Retired while a retired coordinator worker existed. The kinds
come from `pages/desktop/fleet/fleetRows.ts`. A worker reporting
SESSION_EXPIRED was already Parked through `fleetStateParked`
(`packages/shared/src/fleet.ts`: SESSION_EXPIRED, CHECKPOINT, CHALLENGE*,
DEAD).

## Acceptance criteria

- [x] The legend shows All workers, Healthy and Parked, and nothing else.
- [x] A Degraded or Replacing worker counts and filters as Healthy; its State
      column and the replacing Now note are unchanged.
- [x] A silent (offline) worker, or one reporting Session expired /
      Checkpoint / Challenge / Dead, counts and filters as Parked.
- [x] Retired coordinator workers are not rows and have no chip.
- [x] The foot's "R running on K hosts" and the tab bar's running count still
      count running workers only.

## Out of scope

The worker's own page and the Watch page, which show the raw state; the
Proxies tab's Up / Degraded / Down; the states workers report.

## Notes

Mapping chosen in the plan: Degraded and Replacing are still running, so
Healthy; Offline does no work, so Parked; Retired leaves the table entirely
(it was already out of All workers and the counts, RS-418).
