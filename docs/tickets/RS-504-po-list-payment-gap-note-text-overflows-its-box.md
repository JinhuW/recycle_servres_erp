---
id: RS-504
title: PO list payment-gap note text overflows its box
type: bug
status: done
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/seahorse
pr:
version: 1.407.1
related: []
---

## Ask

> Fix this ui.

(With a screenshot of the desktop PO list: the red `!` note on PO-1525 reads
"Payment doesn't match the total cost: the bank paid $10,600.00, the PO totals
$10,632.10 ($32.10 less) Open Payments". The amber box ends after
"$10,600.00", and the rest of the text and the link run past it over the row.)

## Context

The note is `PaymentGapNote` in `apps/frontend/src/components/PaymentMismatch.tsx`.
It is rendered inside the PO list's order-id cell, so it inherits that cell's
`white-space: nowrap`. `.pay-gap-note` caps the box at `max-width: 420px`, and
the single unwrapped line kept going past it.

## Acceptance criteria

- [x] The note's text wraps inside the amber box. Nothing draws outside it.
- [x] "Open Payments" stays on one line, inside the box.
- [x] The note's position is unchanged: it is still fixed under the mark.

## Out of scope

- The PO page's banner (`PaymentMismatchBanner`), which already wraps.
- The note's wording.

## Notes

The fix is CSS only. `.pay-gap-note` resets `white-space: normal` and aligns
items to the top. The icon sits on the first line and the link on the last.
