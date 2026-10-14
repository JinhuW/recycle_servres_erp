---
id: RS-251
title: PO list payment-gap mark: hover note that opens at once
type: bug
status: done
priority: P2
created: 2026-10-14
reporter: jinhu
branch: fix/po-list-payment-gap-hover
pr: 640
version: 1.258.1
related: [RS-250, RS-200]
---

## Ask

> Seem you marked the total cost = payment amount one with a red mark.
>
> pls when user user hover, it should show the note about payment mismatch

(With a screenshot of PO-1491's row: Total cost `$5,835`, Payment
`Company | $5,835`, and the red `!` ahead of the order id.)

## Context

RS-250 (v1.258.0) hung the mismatch note on the mark as a native `title`
attribute, which the browser shows only after a long hover and never on
touch or keyboard focus — so the mark looked unexplained. PO-1491 is a real
gap: the PO totals $5,835.28 and the bank paid $5,835.25 (both legs of the
PayPal/Mercury pair say so). The list rounds both to whole dollars, so the
row reads as agreeing while the cent-exact rule from RS-200 — kept because
staff enter cents-sized rounding fees to make the two agree — marks it. The
note has to show the cents, and show them as soon as the pointer lands.

## Acceptance criteria

- [x] Hovering or focusing the red `!` opens a note at once, beside the mark,
      naming what the bank paid and what the PO totals to the cent, the
      difference, and an *Open Payments* link to that PO's payments.
- [x] The note stays open while the pointer moves into it, closes when it
      leaves, and is never clipped by the table's scroll box.
- [x] Clicking the mark or the note does not toggle the row's line drawer.
- [x] Text is the banner's (EN / ZH); no new strings.

## Out of scope

Relaxing the comparison to whole dollars; a cents display in the Total cost
and Payment cells.

## Notes

The note is a `position: fixed` panel placed by `useFixedPopover`, like the
Payments page's pickers, because `.table-scroll` clips anything that hangs
below the table.
