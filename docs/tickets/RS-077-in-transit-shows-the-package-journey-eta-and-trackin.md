---
id: RS-077
title: In Transit shows the package journey, ETA and tracking number; the PO list gets a Total cost column
type: story
status: in-progress
priority: P2
created: 2026-09-19
reporter: jinhu
branch: feat/po-tracking-and-cost
pr:
version:
related: [RS-050, RS-071, RS-075]
---

## Ask

> update following feature:
>
> 1. when the payment is selfpay, then the paypal should not appear here.
> [Image #4]
> 2. also while the in transit, It should show an shipping tracking bar to know how the shipping status is.
> [Image #5]
>  3. [Image #6] add total cost in this table field.
> 4. [Image #7] Beside to "In Transit", it shows show the expected delivery date. and the link of tracking number.

Four screenshots: the desktop PO page's Payment block with the *PayPal
transaction* field outlined under a Self-paid toggle; the gap between the
status stepper and ORDER DETAILS outlined; the desktop PO list's header row
outlined; the list's bare *In Transit* chip outlined.

## Context

Prod and dev were both on v1.155.1 when this came in, and the prod bundle
already carried RS-071 and RS-075 — the screenshots show an older SPA (the
pre-v1.153.0 "PayPal transaction" label and the pre-v1.155.0 plain chip), so
they came from a tab that had not reloaded since the morning's release.

- **Ask 1** is what v1.153.0 (RS-071) does: every PO surface mounts one
  `PaymentFields`, and its proof panel shows the transaction-ID input only on
  the Company + PayPal path; Self-paid shows the chat-screenshot dropzone
  instead. Nothing to build; verified in the browser.
- **Ask 2**: since v1.142.0 (RS-050) a label hand-off inserts a `packages`
  row linked to the PO, and Shippo keeps its `status` / `tracking_status` /
  `tracking_eta` / `last_tracked_at` fresh by webhook and a 45-minute poll —
  but `GET /api/orders/:id` never returned it, so the PO page showed nothing
  of the box beyond `handoffMethod`. The only place a package's progress was
  visible was the unlisted `#/shipping` page.
- **Ask 3**: list rows already carried `totalCost` (the goods mirror or a
  negotiated override, null on legacy rows) and `otherFees`, but the table
  had no cost column; the dashboard's rule for a PO's cost is
  `COALESCE(total_cost, line sum) + other_fees`.
- **Ask 4**: v1.155.0 (RS-075) made the chip read `In Transit | UPS` and link
  the carrier page, but showed neither the ETA nor the number, because the
  list's `tracking` object carried only carrier, number and URL.

## Acceptance criteria

- [x] Self-paid on every PO surface shows no PayPal transaction field
      (already true since v1.153.0; verified, no change).
- [x] `GET /api/orders/:id` carries `package` — the newest package linked to
      the PO: `{ id, carrier, trackingNumber, trackingUrl, status,
      trackingStatus, trackingEta, lastTrackedAt }`, or `null`. Additive.
- [x] The desktop PO page, while the PO is In Transit and has a package, shows
      a *Shipment* block between ORDER STATUS and ORDER DETAILS: a three-step
      journey (Tracking added → In transit → Delivered; a delivery exception
      as a warning state with the carrier's words), the ETA, the tracking
      number linked to the carrier page, and when the carrier last reported.
- [x] `GET /api/orders` rows carry `goodsTotal` and `tracking.status` /
      `tracking.trackingEta`. Additive.
- [x] The desktop PO list has a **Total cost** column (goods + other fees,
      with an "incl. $x fees" sub-line when fees exist), sortable, in the
      Columns picker, on by default.
- [x] Under the `In Transit | UPS` chip the list shows the tracking number as
      a link to the carrier page and `Est. <date>` when the carrier has given
      an ETA; *Delivered* / *Delivery exception* when the package is past
      that. A local pickup and a legacy PO show nothing extra.

## Out of scope

- The phone PO page and phone list — no ask; the API fields are there for
  them to pick up.
- Per-scan event history. Shippo's `tracking_history` is discarded today
  (`shipping/shippo.ts` `trackToInfo`); the journey is the four-state status.
- A *Refresh* or copy button on the block; the Shipping page keeps those, and
  Refresh would 403 for a purchaser whose manager did the hand-off
  (`packages.ts` `canMutate` is creator-or-manager).
- Clearing `paypal_txn_id` when a saved order flips to Self-paid. The backend
  keeps the id and ignores it; nothing shows it.
- Auto-adding the column to a saved column set. `orders.cols` stores the
  visible ids, so a user who pinned the picker before this release ticks
  *Total cost* on once. A marker in the array was considered and dropped: the
  picker's *None* writes `[]`, which would drop the marker and resurrect the
  column on the next load.

## Notes

- Plan reviewed once before implementation; the review made
  `tracking.status` / `trackingEta` optional on the frontend (the
  `orderPresentation` test fixture and a Worker deployed ahead of Railway both
  omit them), and put `goodsTotal` server-side with the dashboard's rule
  rather than a client-side `poEffectiveCost` call with a misleading override
  argument.
- Verified on the local stack against the populated dev DB: PO-1371's
  package given `in_transit` + an ETA by SQL shows `1Z999AA10123456784 · Est.
  Tue, Sep 22` under the chip and the Shipment block on the PO page; a
  temporary $12 fee rendered `$152` / `incl. $12 fees`; flipping the same PO
  to Self-paid swapped the cash panel for the chat-screenshot panel with no
  PayPal field (ask 1).
- A package reaching `delivered` does not advance the PO (`shipping/track.ts`
  only notifies whoever added it), so the sub-line can read *Delivered* under
  a chip that still says In Transit — that is the truth, not a bug.
