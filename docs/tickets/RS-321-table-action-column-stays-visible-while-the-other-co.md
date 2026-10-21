---
id: RS-321
title: Table action column stays visible while the other columns scroll
type: bug
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: fix-table-actions-column
pr: "#785"version: 1.294.1
related: []
---

## Ask

> Fix the action list get coverred.
>
> [Image #1]
>
> due too many field in the tables and the action list in the last one and make it need to scroll to take actions.
>
> /frontend-design:frontend-design I think maybe we can make other field get scroll and the action list can cover other fields if it is too many field and make sure we can alwasy seem them in the right of the table.

Image #1: [assets/RS-321-actions-covered.png](assets/RS-321-actions-covered.png)
— the Purchase orders list at 10 of 13 columns, with the Actions column
pushed past the right edge of the card.

## Context

The desktop list tables (Purchase orders, Sell orders, the inventory product
table) render inside `.table-scroll`, a container that scrolls sideways once
the table outgrows the card (`min-width: 1160px`). The Actions column is the
last one, so on a laptop-width window with most columns switched on it is the
part that falls off the edge: every open, download or edit costs a trip to the
end of the horizontal scrollbar first.

Since v1.161.x the Purchase orders table already pins its order-ID column to
the left edge under a narrow window (`.col-id`, `desktop.css`), so the
precedent for a pinned column exists. This ticket applies the same idea to the
other end of the row: the Actions cell becomes `position: sticky; right: 0`
with an opaque background, so the data columns slide underneath it and the
buttons never leave the viewport.

## Acceptance criteria

- [x] On Purchase orders, Sell orders and the inventory product table, the
      Actions header and cells stay at the right edge of the card while the
      other columns scroll sideways.
- [x] The pinned cell is opaque: the columns scrolled under it do not show
      through, in the header, on a hovered row and on an archived (faded) row.
- [x] A soft shadow on the cell's left edge shows while any column is hidden
      beneath it and disappears once the table is scrolled to the end; a table
      that fits its card shows no shadow.
- [x] Nothing changes when the table fits: no shadow, no layout shift.

## Out of scope

- Pinning any other column, or making the pinned set configurable.
- The phone list, which has no table.

## Notes

- The edge shadow is driven by a CSS scroll-driven animation
  (`animation-timeline: scroll(nearest inline)`), so it needs no scroll
  listener. A browser without scroll timelines (Firefox at the time of
  writing) gets the pinned column with no shadow, which is the same thing a
  fitting table shows everywhere.
