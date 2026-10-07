---
id: RS-188
title: "Sell-order line numbers: Pack mode and packing lists go by the order's #, a line can be set to 0"
type: story
status: done
priority: P2
created: 2026-10-07
reporter: jinhu
branch: dev-4
pr: "#521"
version: 1.219.0
related: [RS-187, RS-184]
---

## Ask

> So it is not as expected.
>
> A few key things.
>
> 1. In the package list spreadshee add a # for each product in the SO.
>
> 2. The pack mode should not be based on the PO. It should based on the order of item in the list. cuz i will make a label based on the # of the Sell order.then the receiver can easily check them by the label.

> if the product in the SO order, we can mark it as 0, but keep the #. in case, we remove any line, then all # will change.

Clarified in the session:
- Ticked lines in Pack mode → **stay in # order** (no sinking).
- Spreadsheet → **add a # column, keep rows as now** (both packing lists).
- Sell order page → **show # on each line too**.

## Context

Pack mode (RS-187, v1.218.0, dev only) grouped a sell order's lines by source
PO and sank ticked lines, like PO Review mode. Jinhu labels each packed item
with its line's number on the **sell order** and the receiver checks the box by
those labels, so the order's own numbering has to drive Pack mode, appear on
the packing-list spreadsheets and on the order page, and never shift: a line
that can't ship is set to 0 instead of removed. The PO side made the same move
in RS-184 (v1.213.0).

A sell line's # is its 1-based place in the order's list — `position` (which
every write sets to the editor's index), then `created_at`, then `id`.

## Acceptance criteria

- [x] A sell-order line's # is its 1-based place in the order's list (position, then created, then id). Every surface shows the same number.
- [x] The sell order page shows `#n` before each line item, in view and edit; a line added while editing shows its # before saving.
- [x] Both packing-list downloads have a `#` column first; a row folding several lines lists them ascending (`2, 5`). The bid sheet gets no `#` column.
- [x] Pack mode lists lines in # order with no PO grouping; each row's tag is the line's `#n` and its source reads `From PO-1111 #1`; a ticked line stays in place.
- [x] An existing line can be set to qty 0 in the order editor, including a line whose lot is no longer available; it keeps its #, and every other line keeps its #. A newly added line still needs at least 1.
- [x] A qty-0 line is left out of every spreadsheet's rows (bid sheet, both packing lists, price-import matching), shows greyed in Pack mode as nothing to pack, is never matched by a scan, and doesn't block Mark shipped.
- [x] An order whose lines are all 0 can't move to Shipped, Awaiting payment or Done.
- [x] A qty-0 line never: hangs the price adjustment; 500s the PO page's final sell price; writes a NaN market price; flips a lot to Sold or logs a "sold" event on Done.

## Out of scope

- Removing the remove-line button; it stays, for drafts nobody has labelled yet.
- Sorting the spreadsheets by #.
- Archiving a PO still deletes its lines from open sell orders after the archive dialog's confirmation, which renumbers those orders — follow-up candidate: zero them instead.
- Cosmetic or conservative effects of a qty-0 line: dashboard / me / contributions line counts, a draft's "on other drafts" hint, the transfer drafts prompt, the lot's sale history listing it, it still blocking removal of its PO line or deletion of the PO.
- New-order builder and MCP create still require ≥1.

## Notes

- Plan: `~/.claude/plans/dynamic-splashing-lighthouse.md`.
- "A new line needs at least 1" is enforced by the editor, not PATCH: PATCH
  rewrites every row and its typed-line identity includes qty, so it cannot
  tell a zeroed line from a new one. A new line saved at 0 holds nothing, and
  the all-zero guard stops an empty sale.
- Before this, a 0-qty line would have hung `prorateLines` (adjust-price), 500ed
  a PO's final sell price, and recorded NaN market prices.
