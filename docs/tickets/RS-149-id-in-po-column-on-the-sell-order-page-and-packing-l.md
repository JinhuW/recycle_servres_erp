---
id: RS-149
title: ID in PO column on the sell order page and Packing list by PO
type: story
status: done
priority: P2
created: 2026-10-02
reporter: jinhu
branch: feat/sell-order-id-in-po
pr: "#466"
version: 1.197.3
related: [RS-145]
---

## Ask

> Correct me if i am here , The current UI may cause confusion that user may think this is the order in the SO, instead of the # in the source PO

> let we use the ID in PO. a new column in the sell order page.
>
> pls also update the view for the spreadshee in the Package lits by po

> name "ID in PO"

A small "PO #3" badge by the item name was offered and picked first, then
replaced by the column above.

## Context

RS-145 (v1.196.0) gave every sell order line its number on the source PO. By PO
showed it in a leading column headed `#`. That is where a table's own row
number sits, and when a sell order takes lines 1, 2, 3 of a PO, the column reads
1, 2, 3, exactly like row numbering. The number needs a header that says whose
number it is.

The Packing list by PO spreadsheet cuts one tab per PO per warehouse but didn't
carry the number at all, so a picker couldn't match a row back to the PO.

## Acceptance criteria

- [x] The sell order page has an "ID in PO" column right after Item, in view and
      edit, By PO and By warehouse. It shows the line's number on its PO, or
      `—` for a hand-typed line. The By PO "No PO" card has no such column.
- [x] By warehouse's detail row reads "From PO-1432" again, since the number
      has its own column.
- [x] Every tab of the Packing list by PO spreadsheet has an "ID in PO" column
      after Part #. A row that folds several lots of one PO lists their IDs
      ascending ("1, 3"). The per-warehouse Packing list has no such column.

## Out of scope

- The per-warehouse Packing list, which mixes POs.
- The bid sheet (price template).
- Row order inside a pack tab: it stays the bid sheet's order, which the RAM
  group labels depend on.

## Notes

- Numbered RS-149: a peer session claimed RS-146 and RS-147 for its review
  batches and asked for RS-149+.
- The number comes from `lib/poLineNo.ts` (RS-145). The spreadsheet collects it
  only on the by-PO aggregation; the bid sheet and mixed-PO maps would otherwise
  gather numbers from different POs.
