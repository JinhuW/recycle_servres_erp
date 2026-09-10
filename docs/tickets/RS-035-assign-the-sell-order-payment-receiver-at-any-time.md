---
id: RS-035
title: Assign the sell-order payment receiver at any time
type: story
status: done
priority: P2
created: 2026-09-09
reporter: Jinhu
branch: feat/so-receiver-anytime
pr: 293
version: 1.135.0
related: []
---

## Ask

> At any time, The Sell order can still assign payment receiver.

## Context

A sell order's payment receiver (`sell_orders.payment_received_by`, a manager)
records who physically took the customer's money. Until now it could only be
changed from the sell-order edit form, and the edit form is unreachable once
an order is Done or Closed — the list pencil and the "Edit order" button both
hide behind the `locked` guard. So an order whose payment came in after it was
marked Done, or was received by a different manager than expected, could not
record who took the money — exactly when the field matters most.

The backend never restricted this: `PATCH /api/sell-orders/:id` accepts
`paymentReceivedBy` in every status and only locks customer, lines and
currency on Done. The restriction was purely in the desktop detail modal,
which rendered the receiver picker only inside the edit-mode block. Sell
orders are manager-only end to end, so no role plumbing is involved.

## Acceptance criteria

- [x] On a Done or Closed sell order the detail modal shows a receiver picker,
      not read-only text.
- [x] Changing it saves at once (no Edit / Save round trip), the order history
      gains the "Payment receiver" change, and the list's receiver column
      updates.
- [x] In view mode of a Draft / Shipped / Awaiting-payment order the picker
      also works inline; the edit form keeps its existing picker.
- [x] A deactivated current receiver stays selectable (existing behaviour).
- [x] A backend test locks in that a Done and a Closed order accept the
      receiver PATCH.

## Out of scope

- Mobile and vendor shells — neither shows sell orders.
- Renaming the modal's `onAdjusted` callback, which now also means "the
  receiver changed server-side, reload the list".

## Notes

- Plan reviewed before implementation. The "open the edit form for Done orders
  with only the receiver enabled" alternative was weighed and rejected: it
  would touch every input keyed on `editable` plus the Save → navigate-away
  path, whereas an inline live-save picker in the existing view block mirrors
  the negotiated-price `applyAdjust` path and is the smaller change.
