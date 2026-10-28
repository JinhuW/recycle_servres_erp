---
id: RS-440
title: A lot picked from a grouped inventory row keeps its own spec
type: bug
status: done
priority: P1
created: 2026-10-27
reporter: jinhu
branch: JinhuW/opaleye
pr: 973
version: 1.374.1
related: [RS-213]
---

## Ask

> The current sell order download for the price template is downloading some wrong data. pls ultrathink and figure out the root casue and patch an urgent fix

> '/Users/jinhu/orca/workspaces/recycle_servres_erp/opaleye/.orca/drops/SO-4095-UNDECIDED-packing-list-2026-10-28 copy.xlsx'
>
> for exmaple this downloaded spreadsheet does not match the sell order.

> i meant the DDR3 does not exitsing in the sell order

## Context

SO-4095's packing list and bid sheet print product #40 as "Other 8GB DDR3
RDIMM 2Rx4", part `Mixed`, from PO-1495 #10 × 58 and PO-1496 #5 × 48. The
order page shows the same two lines as "Kingston 8GB DDR4 — SODIMM · 1Rx8 ·
2666MHz". The files are right about the lots: both were entered as DDR3
RDIMM on 2026-10-10 and no spec edit was ever logged. The order's saved
label is what is wrong.

The order was created on 2026-10-25 from the desktop Inventory page's grouped
view. That view groups lots by canonical part number, and `Mixed` gathers
lots of unrelated specs. The group's head (newest lot) was PO-1527's Kingston
8GB DDR4 SODIMM, part `mixed`, still in Draft. `/api/inventory/products` sends
each lot without its spec. `DesktopInventory.tsx` (`groupedRowsById`) therefore
built every selected lot's row from the group head's brand, capacity,
generation, type, class, rank and speed. The draft modal sent that as the
line's `label` / `sub_label`, and the server stores the label it is sent.
The files read the lot (`sheetRows`), so they disagree with the page.

The same row feeds "Add to sell order" and "Transfer", so either can
mislabel a lot in a mixed-spec group the same way.

## Acceptance criteria

- [x] `/api/inventory/products` returns each lot's own spec fields on
      `lines[]`.
- [x] A lot selected from a grouped row gets its own brand, capacity,
      generation, type, class, rank and speed in the Create / Add to sell
      order and Transfer hand-offs, not its group head's.
- [x] A backend test covers a mixed-spec group returning per-lot specs.

## Out of scope

- Re-deriving labels server-side for inventory lines (the client still sends
  them). This is a hardening option for later.
- Correcting SO-4095's two saved lines. That is a data decision for the
  owner: relabel them to the DDR3 lots, or remove them if the Kingston DDR4
  lot was the one meant.

## Notes

A prod scan found no other open order whose saved RAM label names a different
generation or capacity from its lot. The remaining mismatches are part-number
typo corrections (O→0, I→1) made to lots after the sale.
