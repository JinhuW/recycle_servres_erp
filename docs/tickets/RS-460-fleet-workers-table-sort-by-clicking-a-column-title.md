---
id: RS-460
title: Fleet Workers table: sort by clicking a column title
type: story
status: backlog
priority: P3
created: 2026-10-29
reporter: jinhu
branch: JinhuW/rs-capacity-lower-warn
pr:
version:
related: [RS-459]
---

## Ask

> pls also add a sort by the table title.

[screenshot: the Fleet tab's Workers table header — Worker, Host, Account,
State, Now, Today, Lease, Version]

## Context

The Workers table on Monitors ▸ Facebook ▸ Fleet (`WorkersTable`,
`apps/frontend/src/pages/desktop/fleet/FleetAccountsTab.tsx`) had plain
headers. Its order was fixed: running workers first, each by worker id. With
27 workers on two hosts there was no way to bring the most-used accounts, the
oldest builds or a host's workers together. The coordinator-era Fleet table
(`FleetWorkers.tsx`) already sorts through `components/SortTh`.

## Acceptance criteria

- [x] Every titled column (Worker, Host, Account, State, Now, Today, Lease,
      Version) sorts when its title is clicked: descending, then ascending,
      then back to the table's own order, like the other sortable tables.
- [x] Worker ids and versions sort naturally (homelab-10 after homelab-2,
      0.15.0 above 0.9.0). State sorts Healthy, Parked, Removed.
- [x] A row with an empty cell goes last in both directions.
- [x] The choice survives switching tabs (the `usePersisted` list memory).

## Out of scope

- Sorting the coordinator-era tables, which already sort.
