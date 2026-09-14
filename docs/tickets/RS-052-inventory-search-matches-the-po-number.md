---
id: RS-052
title: Inventory search matches the PO number
type: story
status: done
priority: P2
created: 2026-09-14
reporter: jinhu
branch: feat/inventory-po-search
pr:
version: 1.143.0
related: []
---

## Ask

> Inventory should also enable to search by PO number.

## Context

The desktop Inventory search box sends `?q=` to `GET /api/inventory` (flat
list and xlsx export, through `inventoryWhereFrag`) and to
`GET /api/inventory/products` (grouped view). Both SQL fragments in
`apps/backend/src/routes/inventory.ts` match brand, part number, serial
number, description and item type only. The placeholder and the FEATURES
bullet have promised "…brand, ID" since v1.42.0, but `o.id` was never in the
fragment, so typing `PO-1442` returned nothing. Every query that consumes
the fragments already joins `orders o`, so the PO id is one more `OR` clause.

## Acceptance criteria

- [x] `GET /api/inventory?q=PO-1442` returns exactly that PO's lines; `1442`
      and `po-1442` match too (substring, case-insensitive, like the other
      fields).
- [x] `GET /api/inventory/products?q=…` matches the same way.
- [x] The xlsx export honours the PO search (shared fragment; no extra code).
- [x] Desktop placeholder says "PO #" in EN and ZH; the vendor portal's
      catalog search placeholder is unchanged.
- [x] Backend test covers full and partial PO id on both endpoints.

## Out of scope

- A search box on the mobile Inventory page (it has none today and sends no
  `q`).
- The inventory activity feed's own `q` (a separate fragment).
- The sellable picker and the MCP inventory search.
- The vendor catalog search: it filters client-side and its data carries no
  PO ids, which is why it gets its own placeholder key instead of the
  reworded one.

## Notes

- Desktop only, agreed with Jinhu on 2026-09-14.
- `DesktopInventoryEdit.tsx` also calls `/api/inventory?q=<part number>` for
  "Stock across warehouses" and filters client-side to the exact part number,
  so extra PO-id rows drop out there. A purely numeric part number could in
  theory have peers displaced by PO-id matches inside the list's 200-row cap;
  negligible at ~1k rows, not special-cased.
