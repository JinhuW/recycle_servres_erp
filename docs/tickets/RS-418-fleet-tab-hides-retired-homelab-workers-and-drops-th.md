---
id: RS-418
title: Fleet tab hides retired homelab workers and drops the phantom rolling bar
type: bug
status: done
priority: P2
created: 2026-10-26
reporter: jinhu
branch: fleet/hide-retired
pr: 938
version: 1.367.0
related: [RS-394, RS-412]
---

## Ask

> Fix two things on the ERP Fleet tab (Monitors ▸ Facebook ▸ Fleet, desktop) the owner reported.
>
> 1. **Retired homelab workers still show.** On 2026-10-27 the 25 unhealthy homelab workers were retired: their containers are gone, and the coordinator set `retired_at` on their worker rows (the console's /v1/fleet health carries `health.retired_at`). The Fleet tab still lists and counts them (37 workers, 23 parked). Hide every coordinator worker with a non-null `health.retired_at` from the table, the chip counts, the host filter and any tab-bar or summary counts. Add a small "Retired N" chip (off by default) that shows them read-only if the owner wants to look. Check the other places the coordinator worker list is counted or listed (Analysis tab, tab-bar counts, worker detail/history links) and apply the same rule; a retired worker's own detail page should still open and say "Retired <date>".
> 2. **"Rolling to 0.14.7: 0 of 1" without a release.** Dev has no release row in fleet_settings (`release` key absent), yet the host card shows a rolling bar because the worker runs 0.14.6 and the default image is 0.14.7. Show the rolling bar only when GET /api/fleet/hosts returns an active release (state rolling); otherwise, when workers run an older build than desired.image, show a quiet note like "1 worker on 0.14.6; new workers start on 0.14.7" with no progress bar. Read how the host card computes it first.

(Relayed by the session that dispatched this work; the owner's report reached it, not this ticket.)

## Context

The Fleet tab's table (`pages/desktop/fleet/fleetRows.ts`, since v1.361.0,
RS-412) merges the ERP's workers with the coordinator's `/v1/fleet` list.
Coordinator worker rows are never deleted: retiring one (the 2026-10-27
cleanup, #935/#936) only stamps `retired_at` on its health row, which the
console passes through verbatim. The table had no notion of it, so the 25
retired workers stayed as Parked or Offline rows, in the legend counts, the
foot and the tab bar's running count's inputs, and kept `homelab` in the host
select.

The host card's progress line came from `rollProgress(host)`
(`fleetBoard.ts`), which looked only at the host: any container on an image
other than `desired.image` made it draw "Rolling to <v>: x of y" with a bar,
whether or not a release existed. `desired.image` falls back to the default
worker image when `fleet_settings` holds no release, so a worker simply left
on the previous build read as a roll in progress.

## Acceptance criteria

- [x] A coordinator worker with a non-null `health.retired_at` is not a row under All or any state chip, is not counted in the legend or the foot, and does not put its host in the host select.
- [x] The tab bar's running count leaves retired workers out (it already counts only running rows; a retired row is never running).
- [x] A **Retired N** chip appears in the legend, off by default, only while N > 0; picking it lists the retired workers read-only (no Park), each with "Retired <date>".
- [x] The activity aside under the table and the Account pool editor's worker picker leave retired workers out (the picker still shows the one an account already names).
- [x] A retired worker's own page (`/fleet/worker/<id>`) still opens, says "Retired <date>" in its sub line, and offers no Re-login.
- [x] The host card draws the rolling line and bar only when GET /api/fleet/hosts returns a release in state `rolling`.
- [x] Otherwise, workers on an older image than `desired.image` get a quiet note: "1 worker on 0.14.6; new workers start on 0.14.7", no bar.

## Out of scope

- The Analysis tab: it reads the coordinator document only for search
  settings, items and the model, never for a worker list or count, so there was
  nothing to filter.
- The coordinator and console: `retired_at` is already served; no tracker
  change.
- Any restart, re-login or host change.

## Notes

- `withoutRetired()` / `retiredAt()` in `lib/fleetView.ts` are the one rule;
  `fleetRows` gives a retired worker the row kind `retired`, which `filterFleetRows`,
  `fleetRowCounts` and `fleetRowHosts` keep out of everything but its own chip.
- `rollProgress(host, release)` now takes the release; `hostLag(host)` names the
  old versions from the containers' image tags (`imageVersion`).
