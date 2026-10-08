---
id: RS-200
title: Warn the manager when a PO's payment doesn't match its total cost
type: story
status: in-review
priority: P2
created: 2026-10-08
reporter: jinhu
branch: dev-12
pr:
version: 1.225.0
related: [RS-009, RS-010]
---

## Ask

> When PO total cost does not match the payment amount, It should shows an alerts to the mamager when they review it.

## Context

A manager approving a PO for payment can't see, in Review mode or on the PO
page, that the bank paid a different amount from what the PO says it cost.
The figure exists already: the PO list's Payment cell (`Company | $X`,
v1.138.0) shows the net of the bank payments linked to the PO. Nothing
compares the two.

- **Payment amount** is the net of the bank payments linked to the PO.
  Refunds subtract, and failed or reversed payments are left out. It is the
  list chip's figure and the ledger's *Net paid*
  (`routes/orders/list.ts`, `GET /api/bank-transactions/by-order/:id`).
- **Total cost** is goods + other fees: the PO page footer's *Total cost*,
  and the cost a linked row shows on the Payments page (RS-009, v1.117.0).
  In prod, every PO that has fees and a linked payment matches goods + fees,
  never goods alone.
- **Company-paid POs only.** Bank money on a self-paid PO would be the
  purchaser's reimbursement plus commission. No self-paid PO in prod has a
  linked payment.
- **The figures must agree to the cent.** Staff already add "Rounding
  adjustment" fees as small as 18¢ to make a PO agree.
- **Surfaces** (asked 2026-10-08): Review mode and the desktop PO page.
- **At approval** (asked 2026-10-08): a mismatch asks for confirmation. It
  does not block.
- **Prod on 2026-10-08:** 13 of 46 linked, unarchived POs mismatch. Examples:
  - PO-1468: $70 total, $2,415 paid
  - PO-1426: $0 total, $4,000 paid
  - PO-1396: $56,053 total, $1,665 paid

## Acceptance criteria

- [x] A manager sees a warning naming the amount paid, the total cost and the
      difference, with a link to the PO's payments:
  - [x] in Review mode, at any stage
  - [x] on the desktop PO page
- [x] Review mode's warning reflects lines counted 0. Approve sets them to
      qty 0, which lowers a goods total that follows the lines, so the
      warning compares against the total the PO will have.
- [x] Two moves ask *Continue anyway?* before anything is written. Cancel
      writes nothing.
  - [x] Review mode's *Approve for payment*
  - [x] a desktop PO-page Save that moves the PO from before Ready to Pay
        into Ready to Pay or Done
- [x] Nothing shows in any of these cases:
  - [x] the amounts agree to the cent
  - [x] no payment is linked
  - [x] the PO is self-paid
  - [x] the viewer is a purchaser, including a manager previewing as one
- [x] `GET /api/orders/:id` carries `linkedPaid` for managers only. For
      everyone else the key is left out, not nulled, as the list does it.

## Out of scope

- The phone. Its next-step button still approves without asking.
- The PO list's Payment cell. It keeps its plain chip.
- POs with nothing linked: cash, self-paid, or a PayPal payment not yet
  synced. There is no payment amount to compare.
- Moves between Ready to Pay and Done, in either direction, and a reopen from
  Sold. Approval has already happened by then.

## Notes

- Plan: `~/.claude/plans/eager-shimmying-deer.md`.
- The "linked paid" subquery was copied in `routes/orders/list.ts` and
  `banktx/match.ts`, with a "keep in step" comment between them. It is now
  one fragment, `linkedPaidFrag` in `banktx/match.ts`, and the detail
  endpoint uses it too.
- Review mode's projected total is exact. A line's qty PATCH moves
  `qty_purchased` by the same amount, and the goods total sums
  `COALESCE(qty_purchased, qty)`.
- `scripts/ticket.sh` allocated RS-198. Two other worktrees already held that
  number, so this ticket took RS-200.
