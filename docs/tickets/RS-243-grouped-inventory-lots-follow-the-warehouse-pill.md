---
id: RS-243
title: Grouped inventory lots follow the warehouse pill
type: bug
status: done
priority: P2
created: 2026-10-12
reporter: jinhu
branch: fix/inventory-warehouse-lots
pr:
version: 1.252.1
related: []
---

## Ask

> when i select the warehouse here.
>
> (with a screenshot of the desktop Inventory page, DEN pill selected, the
> expanded "Lots in Kingston 4GB DDR4" table outlined)
>
> The lots in xxx shoudl only show the filtered warehouse inventory

## Context

The desktop Inventory grouped view (`pages/desktop/DesktopInventory.tsx`,
`InventoryProductTable.tsx`) is fed by `GET /api/inventory/products`. The
warehouse pill sends `?warehouse=<id>`, and the route keeps a product when
*any* of its lots sits in that warehouse — but it still returns every lot
of the product in `lines`, and sums qty, cost range, lot and PO counts and
the Warehouses column across all of them. So with DEN selected a product
with lots in DEN and BOSTON opens to a "Lots in …" table that lists the
BOSTON lots too, and its row says "DEN, BOSTON" and counts both.

The per-lot narrowing already exists for Select all (`sellable_ids`,
v1.230.2); the listed lines and the group summary never got it.

## Acceptance criteria

- [x] With a warehouse pill selected, a product's expanded lots table lists
      only the lots in that warehouse.
- [x] The product row's qty (total, in stock, in transit, reviewing), lot and
      PO counts, cost range and Warehouses column count only those lots.
- [x] The warehouse pill counts and the attribute chip counts are unchanged
      (they are drop-self facets and already ignore the active warehouse).
- [x] "All warehouses" still shows every lot.

## Out of scope

- Narrowing the listed lots to the attribute chips the same way. A product
  with a mis-typed lot is a data problem the full list helps find, and the
  ask was about the warehouse pill.
- The phone Inventory list, which is flat and already filters per lot.

## Notes

- Fixed on the server so the row summary and the lots table can't disagree:
  the group is narrowed to the warehouse's lots before anything is summed.
