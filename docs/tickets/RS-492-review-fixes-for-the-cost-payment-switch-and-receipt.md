---
id: RS-492
title: Review fixes for the Cost Payment switch and receipt names
type: bug
status: in-review
priority: P2
created: 2026-10-31
reporter: jinhu
branch: fix/rs-490-491-review
pr:
version:
related: [RS-490, RS-491]
---

## Ask

> /code-review dev to main, fix all issues and merge to prod.

## Context

The review of the dev → main release (RS-490 v1.397.0, RS-491 v1.398.0) found
that two acceptance criteria of those tickets did not hold, plus a few smaller
regressions:

- RS-490: moving the Cost Payment switch to Business Account and back named
  the signed-in manager instead of keeping the payer, because both PO pages
  drop the person when the payment goes to the Business Account. Saving that
  would have moved the purchaser's RMB entries to the manager.
- RS-491: the upload read the receipt a second time and renamed from that
  reading, so the stored name could differ from the chip (a UTC date rollover,
  a different reading), and every image cost two model calls.
- `/scan-receipt` refused images over the upload cap that the upload itself
  shrinks, so large phone screenshots got neither the name nor the amount.
- A PO saved as Business-paid no longer showed its RMB book (voided history)
  on either page.
- The Payments ledger followed the role preview instead of the real role.

## Acceptance criteria

- [x] RMB Flow → Business Account → RMB Flow keeps the payer who was there.
- [x] An upload whose name is already a receipt name is stored under it, with no second model call.
- [x] `/scan-receipt` shrinks an oversized image before reading it, as the upload does.
- [x] A PO saved as Business-paid shows its RMB book, read-only, under Business Account (desktop and phone).
- [x] A manager previewing as a purchaser still sees the PO's Payments ledger.
- [x] The Cost Payment and Commission switches are one component.

## Out of scope

—

## Notes

RS-490's criterion "A locked payer disables the switch" cannot occur: the
switch is a manager's, and the server sets `payerLocked` only for non-managers.
The dead lock branch was removed rather than kept.
