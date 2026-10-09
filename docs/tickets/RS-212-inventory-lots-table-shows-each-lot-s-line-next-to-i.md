---
id: RS-212
title: Inventory lots table shows each lot's line # next to its PO
type: story
status: done
priority: P2
created: 2026-10-09
reporter: jinhu
branch: feat/inventory-lot-po-line-no
pr: 565
version: 1.232.0
related: [RS-145]
---

## Ask

> [Image #1]
>
> It should append with the # id in the P.

(The screenshot is the desktop Inventory grouped view, product "Kingston 8GB
DDR4" expanded, with a red box drawn just right of `PO-1483` in the PO cell of
the "Lots in …" table.)

## Context

A lot is a PO line, and the PO page numbers its lines `#1, #2, …`. Sell
orders, the sellable picker and the flat inventory API already carry that
number (`poLineNo` in `apps/backend/src/lib/poLineNo.ts`, RS-145, v1.196.0),
but the lots table under an expanded product shows only the PO id, so finding
the lot on a long PO means scanning it by part number.

The table is `pages/desktop/InventoryProductTable.tsx`; its data is
`GET /api/inventory/products`, whose lot objects didn't carry the number.

## Acceptance criteria

- [x] `GET /api/inventory/products` gives each lot `po_line_no`, equal to the
      lot's index on `GET /api/orders/:id` — across position gaps, ties and a
      partial-transfer clone.
- [x] The lots table's PO cell reads `PO-1483 #3`: the PO id stays the link,
      `#3` follows it on the same line, with a "Line 3 on PO-1483" tooltip.
- [x] A lot picked in the grouped view and added to a sell order carries its
      PO line # there too, also when it isn't among the flat list's 200 rows.

## Out of scope

- The item page (`DesktopInventoryEdit.tsx`) also links the lot's PO; it reads
  `GET /api/inventory/:id`, which has no line #. The ask is the lots table.
- Exports: neither carries the PO id.

## Notes

- Plan: `~/.claude/plans/keen-snacking-sifakis.md`.
- Not role-gated: purchasers already get the PO id and, from the flat list,
  the line #.
