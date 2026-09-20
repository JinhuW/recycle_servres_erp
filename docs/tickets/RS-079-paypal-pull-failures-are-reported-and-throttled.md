---
id: RS-079
title: PayPal pull failures are reported and throttled; the phone scan keeps concurrent edits
type: bug
status: in-progress
priority: P2
created: 2026-09-19
reporter: jinhu
branch: session/20260918-202813
pr:
version:
related: [RS-069, RS-076]
---

## Ask

> /code-review high dev -> prod. Once all issue cleared and release to prod.

Then, on the four findings the review returned, offered as a patch:

> yes, go haead.

## Context

The `dev -> prod` review of v1.150.0 – v1.155.1 (run 2026-09-19, after
that range had already reached prod as PR #361) returned four findings,
none release-blocking, all on the PayPal transaction rule (RS-069) and its
on-demand pull (RS-076):

| # | Where | Defect |
|---|---|---|
| F1 | `routes/orders.ts` `pullPaypalIfUnknown` | A failed pull (PayPal down, key expired) is discarded — `syncBankTransactions` folds the provider error into `result.perSource.paypal.error`, nobody reads it, `reportSyncResult` is never called. The user is told "isn't in our PayPal account — check the ID" for an ID that may be fine, and nothing is logged from this path. |
| F2 | `shipping/track.ts` `applyShipmentTracking` | `unknownTxnId` from the carrier-movement advance is warned once and never retried: the shipment row still moves to `in_transit`, so `nextStatus` is null on every later poll. A Draft whose payment PayPal reports up to 3 h late stays Draft, id already filled in, until a human presses Submit. |
| F3 | `routes/orders.ts` `/advance`, `/handoff` | The pull is unthrottled beyond the in-process single flight: any purchaser with a Draft and a fabricated 17-character id can trigger a Transaction Search plus dispute list per request. |
| F4 | `pages/OrderDetail.tsx` | `setTxnId: v => setMeta({ paypalTxnId: v })` — `setMeta` spreads the `meta` captured at render; the OCR scan awaits for seconds, so notes or a warehouse typed meanwhile are reverted when the scan lands. |

A fifth candidate from the release review — `goodsTotal` on the PO list
could be SQL `NULL` — turned out not to be a defect: the column is
`COALESCE(o.total_cost, SUM(…), 0)`.

Precedent for a review-fix ticket: RS-022, RS-025, RS-038.

## Acceptance criteria

- [x] When the on-demand PayPal pull itself fails, `/advance` and `/handoff`
      refuse with a message that says PayPal could not be reached (not
      "check the ID"), the response carries `pullFailed: true`, and the
      failed pass is in the log like the six-hourly loop's.
- [x] A user gets at most 3 on-demand PayPal pulls per minute; beyond that
      the guard judges the synced table as it stands, with its usual message.
- [x] On the phone PO page, notes or warehouse edits made while a PayPal
      screenshot is being read survive the scan result.

## Out of scope

- **F2, dropped as moot.** The fix — a sweep after each bank sync that
  re-offered the system-actor advance to every Draft behind a moving
  shipment — was built and tested, then removed during rebase: RS-078
  (#365, v1.157.0) deleted the prepaid-label flow and with it the only
  tracking-driven advance (`applyShipmentTracking` → `advanceOrderTx`).
  Nothing can leave a Draft stalled behind a box any more; a PO leaves
  Draft only by a person's Submit or hand-off, which pull PayPal themselves.
- `goodsTotal` nullability — not a defect (see Context).
- A per-order cooldown on the pull: per-user is enough, the cost being
  PayPal quota rather than correctness.

## Notes

- Plan reviewed under `plan-first` on 2026-09-19; the reviewer's one
  blocking point was test isolation for the rate limiter (module-level Map,
  no reset), resolved by giving the throttle case its own actor.
- Moved twice during implementation: #364 took 1.156.1 while the ticket was
  being written, then #365 took both 1.157.0 and the number RS-078 while
  the PR waited for CI — hence RS-079 and 1.157.1.
