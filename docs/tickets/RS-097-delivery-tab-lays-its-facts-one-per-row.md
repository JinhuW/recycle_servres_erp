---
id: RS-097
title: Delivery tab lays its facts one per row
type: story
status: in-progress
priority: P2
created: 2026-09-21
reporter: jinhu
branch: fix/rs-097-delivery-tab-rows
pr:
version:
related: [RS-080, RS-094]
---

## Ask

> I hope it can be group by different purposeReceiving warehouse.
>
> for example:
>
> Source can be in the first line.
>
> Receiving warehouse in the second line.
>
> How it get here and Pick up in the same line.
> Pls use more clear UI to distinguish them

(with a screenshot of the desktop PO page's Delivery tab: Source, Receiving
warehouse and How it gets here across one row, and *Picked up by* on the
next row, directly under Source)

## Context

The desktop PO page's Delivery tab (`pages/desktop/order/DeliveryTab.tsx`,
on the page since v1.158.0) lays its facts on a three-column grid: Source ·
Receiving warehouse · How it gets here on the first row, and the field the
delivery choice needs — *Picked up by*, or *Tracking number* plus the
carrier chips — on a second three-column row. On a wide window that
follow-up field lands under Source, so *Picked up by* reads as if it
belonged to Source rather than to *Local pickup*. The phone fold already
stacks the same facts one under the other; only the desktop tab has the
problem.

## Acceptance criteria

- [x] Source alone on the first row, Receiving warehouse alone on the
      second, each in the first of three equal columns.
- [x] *How it gets here* on the third row with *Picked up by* (pickup) or
      *Tracking number* + carriers (label) beside it, never under Source.
- [x] A hairline separates the three rows; nothing else on the tab moves
      (package line, note, footer).
- [x] Frozen (disabled) and empty-delivery states render the same rows.

## Out of scope

- The phone Delivery fold — it already stacks these.
- Group captions over each row: the field labels already name the fact,
  a caption would repeat them.
- An uneven column split on the label row to keep the three carrier chips
  on one line at 1440px: it would pull the switch out of the column Source
  and Warehouse share, which is the point of the rows. The chip strip wraps
  there, as it does in the hand-off dialog.

## Notes

Plan: `~/.claude/plans/starry-scribbling-cat.md`. Desktop-only change in
`DeliveryTab.tsx` and `styles/desktop.css`; no i18n, no props, no backend.
Numbered RS-097 rather than the RS-095 `ticket.sh` hands out because a peer
PR (#391) already carries RS-095 on a branch the script cannot see.
