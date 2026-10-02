---
id: RS-152
title: Sell order By PO shows the source PO line as a PO #n badge
type: story
status: in-progress
priority: P2
created: 2026-10-02
reporter: jinhu
branch: feat/sell-order-po-line-badge
pr:
version:
related: [RS-149, RS-145]
---

## Ask

> revert this change. let we keep use the badge

Answers to the two scoping questions:

> The badge replaces the "ID in PO" column on the sell order page. What should
> happen to the "ID in PO" column in the Packing list by PO spreadsheet? —
> **Keep it**

> Where should the badge show on the sell order page? — **By PO only**

## Context

"This change" is RS-149 (v1.197.3). It put the source PO line number in an "ID
in PO" column on the sell order page, in both views, and in a matching column in
the Packing list by PO spreadsheet.

"The badge" is the `PO #3` pill after the item name. It was offered and picked
during RS-149, then replaced by the column before anything shipped. RS-145
(v1.196.0) had shipped a leading `#` column. So this is a hand edit to the
badge design, not a `git revert`: reverting RS-149's frontend would bring back
the `#` column.

## Acceptance criteria

- [ ] The sell order page has no "ID in PO" column, in view or edit mode, in
      either view.
- [ ] By PO: a line from a PO shows a grey `PO #3` pill after its item name.
      Hovering it reads "Line 3 on PO-1432". A hand-typed line has no pill.
- [ ] By warehouse: the line's detail row reads `From PO-1432 #3`, as in
      v1.196.0.
- [ ] Lines picked in edit mode show the pill before saving.
- [ ] The Packing list by PO spreadsheet keeps its "ID in PO" column.

## Out of scope

- The spreadsheet column (kept by request).
- PO-order sorting inside a By PO card (unchanged).

## Notes

- The badge's tooltip reads the PO from `line.sourceOrderId`, not the cell's
  local `po`. That one is null in By PO, where `showPo` is false.
- Numbered RS-152: a peer session holds RS-150 and RS-151 and asked for RS-152+.
