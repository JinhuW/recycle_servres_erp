---
id: RS-569
title: Commission rate and notes editable at Ready to Pay
type: story
status: done
priority: P2
created: 2026-11-07
reporter: jinhu
branch: JinhuW/feat-commission-rate-editable
pr:
version: 1.445.0
related: [RS-131, RS-567]
---

## Ask

> The commission rate can be update in ready to pay status.

> btw. I hope the note also able to add before done.

## Context

From Ready to Pay the PO is closed book. Ready to Pay is payment review: the
commission is owed but not yet paid, and Done means it was paid. The sell
price already stays a manager's at Ready to Pay for this reason (RS-131
v1.191.1 on the PO page, RS-567 v1.444.1 in Review mode). The commission rate
is the other input to the same projection.

`PATCH /api/orders/:id` listed `commissionRate` among the closed-book fields
and refused it with 409 (`routes/orders/patch.ts`, `doneLocked`). Review mode's
Commission card (`rateLocked` in `DesktopBoxCheck.tsx`) and the PO page's
Commission tab (`orderLocked` in `order/CommissionTab.tsx`) both disabled the
input from Ready to Pay on. Every reader computes commission live from
`commission_rate`, so a change re-projects with nothing stale. The rate is an
audited order field, so Activity records each change.

Notes were already allowed on the server. A manager may append a note on a
closed-book PO (`patch.ts`, and the test "a manager may append a note" in
`orders-ready-to-pay.test.ts`) and write Submission files at any stage
(`canWriteMeta` in `routes/orders/evidence.ts`). Only the desktop PO page's
Notes & files tab blocked it, because it is gated on `canAnnotate`, which is
false once the order locks.

## Acceptance criteria

- [x] A manager's `PATCH /api/orders/:id {commissionRate}` on a Ready to Pay PO
      returns 200. The PO stays at Ready to Pay and the new rate reads back.
- [x] A purchaser's attempt returns 403. A Ready to Pay patch that pairs the
      rate with another frozen field (`otherFees`) returns 409 and writes
      nothing.
- [x] At Done the rate is still refused with 409.
- [x] In Review mode at Ready to Pay, the Commission card's rate field is live
      and saves on Enter or blur. At Done it is disabled and shows the locked
      hint.
- [x] On the desktop PO page at Ready to Pay, a manager can edit the
      Commission tab's rate. Save writes it and stays on the PO. The owner
      select stays locked.
- [x] On the same page and stage, the Notes & files tab's note and Submission
      files are editable for a manager, and Save writes the note. At Done they
      are read-only. A purchaser can't edit them at Ready to Pay.

## Out of scope

- The phone PO page. Its rate and notes stay read-only past review, as its
  sell price does.
- Purchaser notes past review. The server still refuses them with 403.
- Done. It stays locked in the UI for the rate, notes and files.
- The owner and the other closed-book fields.
- The Payment tab's proof uploads.
- A guard against changing the rate after a commission payment is linked
  while the PO is still at Ready to Pay. The sell price has no such guard
  either.

## Notes

- Asked about scope, the owner chose desktop only for the rate, and managers
  only, note and files together, for the notes.
- The "may a manager edit this through payment review" predicate moved into
  `lib/poPermissions.ts` as `paymentReview`. It was `canEditSellPrice`, local
  to `DesktopEditOrder.tsx`. Now the sell price, rate, note and files share one
  rule, and it has a unit test.
- Plan: `~/.claude/plans/playful-soaring-giraffe.md`.
