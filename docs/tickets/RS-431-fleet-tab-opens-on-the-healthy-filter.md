---
id: RS-431
title: Fleet tab opens on the Healthy filter
type: story
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/fleet-healthy-default
pr: 962
version: 1.371.0
related: []
---

## Ask

> The facebook fleet show healthy filter by defaults.

## Context

Monitors → Facebook → Fleet opened with the **All workers** chip pressed, so
the table led with offline and parked rows. The initial filter was
`EMPTY_FLEET_ROW_FILTER` (`kind: 'all'`) in
`apps/frontend/src/pages/desktop/fleet/fleetRows.ts`, used as the tab's
initial state in `FleetAccountsTab.tsx`. Pressing a pressed chip, or All
workers, already returns to every worker (`Legend` in `fleet/shared.tsx`).

## Acceptance criteria

- [x] Opening the Fleet tab shows the Healthy chip pressed and only healthy workers.
- [x] All workers, the other chips, the host select and search work as before; the counts are unchanged.
- [x] When no worker is healthy the table shows the existing "no match" empty row, not "no workers".

## Out of scope

Remembering the chosen filter across visits; the defaults of the Tasks,
Proxies and Account pool tabs.
