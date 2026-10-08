---
id: RS-198
title: Sell orders need every manager's sign-off before Done
type: story
status: done
priority: P2
created: 2026-10-08
reporter: jinhu
branch: feat/sell-order-signoff
pr: "#543"
version: 1.226.0
related: []
---

## Ask

> Think of an signoff Section for the Sell Order.
>
> To move an sell order to done. It must has maager's sign off on it.
>
> for example, a sell order to close it will need Tim and Jinhu to sign off on it.

## Context

Any one manager could move a sell order to Done, and Done is the step with
consequences: it consumes stock, records market prices from the line prices,
settles the source POs and starts their commission. Nobody else had to look
at the deal first.

Decided while planning (asked in chat):

- **Who signs: every active manager**, worked out live from
  `users.role = 'manager' AND active = TRUE`. On 2026-10-08 prod had Jinhu and
  Tim Wu active and the "Admin" account inactive, so "Tim and Jinhu" is exactly
  that set. A manager added later is required from then on; one deactivated
  stops being required.
- **Edits void sign-offs.** A sign-off approves the order as it stood. Changing
  the customer, the currency, or any line's item, qty, native price or lot
  makes it read "needs to sign again". Notes, the payment receiver, a
  warehouse move and evidence uploads don't.
- **Signing only unlocks Done.** A manager still moves the order to Done in the
  stepper, so the Done evidence dialog runs as before.
- Sign-off is open in Draft, Shipped and Awaiting payment. A manager signs only
  for themselves and may withdraw until Done. Reopening a Closed order clears
  its sign-offs — a revived deal is a new deal.

Prod on 2026-10-08: 7 Draft, 35 Done, 25 Closed sell orders. Done orders are
not back-filled.

## Acceptance criteria

- [x] `POST /api/sell-orders/:id/status` to Done is refused with a 409 naming
      every active manager who hasn't signed the order as it stands.
- [x] The sell order page has a Sign-off card listing each manager as signed
      (with time), waiting, or needing to sign again, with Sign off / Sign
      again / Withdraw on the viewer's own row.
- [x] The stepper's Done step is disabled until sign-off is complete, and
      while unsaved edits would void it, with the reason in its tooltip.
- [x] Line, qty, price, lot, customer or currency changes — through the editor,
      a negotiated total, or a PO archive taking a line off — void earlier
      sign-offs; notes, receiver and warehouse changes don't.
- [x] Signing and withdrawing appear in the order's history, and a sign-off
      notifies the managers still to sign.

## Out of scope

A "waiting on my sign-off" filter on the sell order list; sign-off on
purchase orders; back-filling sign-offs on orders already Done.

## Notes

Each sign-off stores a fingerprint of what was approved (customer, currency,
and per line the item, part #, condition, qty, native price and — for a line
above 0 — its lot). It counts only while that still matches the order, so no
writer has to remember to clear sign-offs. Native price, so a line rewrite at
a new FX rate doesn't void it; sorted by content, so resending identical lines
doesn't either. Plan: `~/.claude/plans/piped-cuddling-hopper.md`.

A sign-off also names the version the manager reviewed: the order detail
returns the fingerprint and `POST /signoff` must send it back, so an edit that
lands between the review and the click is refused (409) instead of being
signed unseen. Added during implementation after a security review flagged it.

Shipped as v1.226.0, not the 1.223.0 first planned: peers' #541 and #542 had
claimed 1.223.0 and 1.225.0.
