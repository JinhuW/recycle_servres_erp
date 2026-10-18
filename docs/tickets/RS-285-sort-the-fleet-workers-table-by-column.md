---
id: RS-285
title: Sort the Fleet workers table by column
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/tracker-worker-sort
pr: 713
version: 1.281.0
related: []
---

## Ask

> enable sort for this table:
> [Image #1]

(The image is the header row of the Fleet workers table: Worker, Status, Today,
Searches, Session, Posts.)

## Context

`WorkersCard` in `apps/frontend/src/pages/desktop/FleetWorkers.tsx` (Account
pool → Fleet) renders workers in the fleet document's order, and its headers
are plain `<th>`. The Orders table already sorts client-side with a `SortTh`
header in `DesktopOrders.tsx`; this reuses it.

## Acceptance criteria

- [x] Clicking Worker / Status / Today / Searches / Session / Posts sorts the rows; the header shows a caret and `aria-sort`.
- [x] A click cycles desc → asc → back to fleet order.
- [x] Unknown values (no health, no counts) sort last in both directions.
- [x] The sort survives leaving and returning to the tab.
- [x] Search and the status-legend filter still apply on top of the sort; an expanded fold stays with its row.

## Out of scope

Server-side sort; sorting the Activity aside or the Accounts tab; the cities
and eye columns.

## Notes

- Today sorts by last heartbeat (the cell's tooltip), since the day bar itself
  has no single comparable value. Status sorts in legend order (live, stale,
  attention, offline).
- `SortTh` moved from `DesktopOrders.tsx` to `components/SortTh.tsx`.
