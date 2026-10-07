---
id: RS-186
title: Packing list shows each row's source PO line
type: story
status: in-review
priority: P2
created: 2026-10-07
reporter: jinhu
branch: feat/packing-list-source-po
pr:
version:
related: [RS-149, RS-152, RS-145]
---

## Ask

> In the sells order. For the package list. I hope each line of item will also have a source of the PO with the #line in the PO.

Answer to the layout question (a per-warehouse row can fold one product from
several POs):

> One row, list sources

## Context

The sell order page already names every line's source (`From PO-1432 #3` in By
warehouse, a `PO #3` badge in By PO), and the Packing list by PO spreadsheet
has an "ID in PO" column (RS-149). The per-warehouse Packing list had nothing:
RS-149 left it out because one of its rows folds the same product across
several POs, so a single line number names nothing there.

## Acceptance criteria

- [x] Every `Pack - <warehouse>` tab of the Packing list has a "From PO" column
      right after Part #.
- [x] A row from one PO line reads `PO-1442 #3` — the same # the PO page shows.
- [x] A row folding several sources lists each on its own line in the cell
      with its qty (`PO-1442 #3 ×8`, `PO-1450 #1 ×4`), POs in numeric order, a
      hand-typed part last as `No PO ×2`; the row is tall enough to show them
      all and its cells sit at the top.
- [x] A row made only of hand-typed lines reads `—`.
- [x] Rows, quantities, tabs and totals are unchanged; the Packing list by PO
      keeps its "ID in PO" column and gets no "From PO" column.
- [x] Uploading the Packing list to the price import is still rejected.

## Out of scope

- The bid sheet (price template): it goes to vendors.
- Splitting a folded row per PO line (offered, not picked).
- The sell order page, which already shows the source.

## Notes

Plan: `~/.claude/plans/velvet-sleeping-acorn.md`. Numbered RS-186 / v1.216.0:
peer sessions hold RS-184/1.213.0, RS-185/1.214.0 and RS-187/1.215.0.
