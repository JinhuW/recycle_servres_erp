---
id: RS-596
title: Show each inventory product's last collected date
type: story
status: backlog
priority: P2
created: 2026-11-16
reporter: jinhu
branch: session/20261116-074805
pr:
version:
related: []
---

## Ask

> In the inventory page, for each item. I would like to show the last collected date.
>
> cuz i would like to clear them after certain amount of time.

## Context

The desktop Inventory page defaults to the grouped view (`GET
/api/inventory/products`, `InventoryProductTable.tsx`), which showed no date at
all. Its lots table had a Date column, but that is the line's `created_at`,
and a partial transfer clones a lot with a fresh `created_at`, so a moved lot
looked brand new. Stock that has sat too long is what the owner wants to find
and clear.

"Collected" is when the PO's goods were handed off (Draft → In Transit): the
newest `handoff` row in `order_events`, written since the hand-off checkpoint
existed. Older POs have none, so they fall back to the PO's `created_at`.

## Acceptance criteria

- [x] `/api/inventory/products` sends `collected_at` on every lot and, on every
  product, the newest of its lots' (scoped to the warehouse pill like the
  other sums).
- [x] The grouped table has a **Last collected** column: the date and how long
  ago it was.
- [x] The column sorts (newest first, then oldest first), server-side and in
  the table, like the other columns.
- [x] Each lot in a product's lots table shows its own collected date.

## Out of scope

- Clearing old stock automatically, or a "older than N days" filter: the ask is
  to see the date first; sorting oldest-first already lists what to clear.
- The flat view and the phone list, which keep the lot's own date.

## Notes

- A transferred clone keeps its source PO, so it keeps its collected date.
