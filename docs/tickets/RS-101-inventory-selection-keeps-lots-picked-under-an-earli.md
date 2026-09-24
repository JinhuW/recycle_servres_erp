---
id: RS-101
title: Inventory selection keeps lots picked under an earlier search
type: bug
status: done
priority: P2
created: 2026-09-24
reporter: Jinhu
branch: fix/inventory-selection-across-searches
pr: "#396"
version: 1.174.1
related: []
---

## Ask

> help me fix a bug in the inventory,
>
> when i search the po in the search box and select the inventory in the list. it will show i seect 7 of them. but when i select another PO and select all inventory in them, then select them. it will only show 5.
>
> clear the search, my total select is 5.

## Context

The desktop Inventory page kept every selected lot id, but it turned ids into
rows only through what the *current* search had loaded (the flat list and the
grouped products, each capped at 200). Lots picked under an earlier search
dropped out of the selection bar's count and totals, and out of Create sell
order, Transfer and Export selected. That held even after the search was
cleared, whenever those lots fell outside the capped list.

## Acceptance criteria

- [x] Select PO A's lots, search PO B and select its lots: the bar shows A + B.
- [x] Clearing the search keeps the A + B total.
- [x] Create sell order / Transfer / Export selected carry every selected lot.
- [x] Clear, and saving a sell order or transfer, still empty the selection.

## Out of scope

Refreshing a remembered lot's qty or price while no search returns it. The
server re-validates the sell order and the transfer.

## Notes

`lib/inventorySelection.ts` keeps a snapshot of each selected row from when it
was last loaded. Fresh data always wins over the snapshot. Bulk drafts now list
lots in selection order.
