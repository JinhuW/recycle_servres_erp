---
id: RS-343
title: Reopen a Done sell order to Awaiting payment
type: story
status: done
priority: P2
created: 2026-10-22
reporter: jinhu
branch: JinhuW/triggerfish
pr: 816
version: v1.311.0
related: []
---

## Ask

> Enable the ability to move a done sell order to editable status.

## Context

A Done sell order is terminal. `ALLOWED_TRANSITIONS.Done` in
`apps/backend/src/routes/sellOrders.ts` is empty, `STRUCTURE_LOCKED_STATUSES`
refuses a PATCH of its lines, and the order page offers no *Edit order*. So an
order marked Done by mistake, or one whose lines or prices need correcting
after the fact, cannot be fixed. The only reopen is Closed → Draft
(creator-only, note required, v1.15.0).

Done is not just a label. The transition decrements every source lot by the
units sold, or flips a sold-out lot to `Sold` with its qty kept, and writes a
`sold` inventory event per lot. It re-syncs each source PO's goods total,
records one `sale:<id>` market data point per product, and stamps `done_at`,
which the dashboard and contributions read (always together with
`status = 'Done'`). A way back has to undo the stock and the market points, or
the next Done consumes the same units twice and records the sale twice.

The order goes back to **Awaiting payment**, the last editable stage before
Done. It is committed, so the order re-reserves exactly the units it hands
back and no rival order can take them while it is being corrected. An
after-sales case can still be opened on it. And the existing archived-order
guard already refuses it, so an archived order is unarchived first.

## Acceptance criteria

- [x] A manager can move a Done sell order to Awaiting payment with a note:
      `POST /api/sell-orders/:id/status {to: 'Awaiting payment', note}`.
      Without a note it is a 400.
- [x] Every unit the sale consumed returns to its lot. A partly sold lot gets
      its qty back. A sold-out lot leaves `Sold` for its PO's line status,
      holding the units this order took. The order reserves them again. One
      `unsold` inventory event is written per lot.
- [x] The order's `sale:<id>` market points are removed, and a part whose last
      price came from them falls back to its previous point (or to none).
- [x] `done_at` is cleared, so the sale leaves the dashboard and contributions
      until it is Done again. Done again stamps a fresh date.
- [x] The reopen note is appended to the order's notes (`Reopened: …`), and
      History logs `reopened` from Done. The Awaiting-payment evidence note is
      not overwritten.
- [x] The reopen is refused with a 409, changing nothing, when the order is
      archived, or when a lot it would hand back is no longer sellable: its PO
      is archived or not at Reviewing / Done, or the lot itself was archived.
      The refusal names the lot.
- [x] Sign-offs are kept. An edit invalidates them as usual, and Done again
      consumes the stock exactly once.
- [x] Done → Draft and Done → Closed stay illegal.
- [x] The Done order page shows *Reopen* to a manager while the order is not
      archived. The dialog reads Done → Awaiting payment and asks for a note,
      and on success the page stays on the order, now editable.

## Out of scope

- Reopening Done to Draft or Shipped. Draft would drop the reservation and
  can't take an after-sales case, and one target keeps the stock rules simple.
- A creator-only rule. Every active manager signs a Done, so any manager may
  undo one.
- Retracting the "commission ready" notification Done sent to the submitters.
- Mobile: it has no sell-order status controls.

## Notes

- Done again stamps a new `done_at`, so a sale corrected in a later month
  moves to that month on the dashboard. That is deliberate: the figures it
  reports are the corrected ones.
- `qty_purchased` is left alone on the way back. Done parked the bought count
  there before decrementing, so the PO's goods total does not move.
