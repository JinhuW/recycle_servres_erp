---
id: RS-345
title: Fix the sale-reopen review findings before the v1.311 release
type: bug
status: in-progress
priority: P1
created: 2026-10-22
reporter: jinhu
branch: JinhuW/glassfish
pr:
version:
related: [RS-343]
---

## Ask

> /code-review high from dev to prod. release to prod. ocne you fix all identified issues.

## Context

The only change on `dev` that hasn't reached `main` is PR #816, which reopens a
Done sell order to Awaiting payment (RS-343, v1.311.0). A high-effort review
of `origin/main...origin/dev` found ten defects in it, all in
`POST /api/sell-orders/:id/status` and the code around it:

1. **Stale save reopens a sale.** The route decided a move to Awaiting payment
   was a reopen from the stored status alone. An editor opened while the
   order was Shipped, saved after someone else marked it Done, posted
   `{to: 'Awaiting payment', note}` and reopened the sale without meaning to.
   Before v1.311.0 that save got a 409.
2. **Oversold lot restored with phantom units.** A sold-out lot was given back
   all the units the order asked for (`s.q`). If Done had oversold the lot
   (the order held more than the lot had left), the reopen created units that
   never existed.
3. **Sold-out lot moved backwards.** A sold-out lot took its status from its
   PO's *current* lifecycle. A lot sold at Done on a PO since moved back to
   Reviewing came back as Reviewing, which `orderAdvance.ts` forbids for a
   committed line.
4. **Open cases and money ignored.** Nothing stopped a reopen of an order with
   an open after-sales case, whose line links the next save strips. Nothing
   stopped a reopened sale with payments or cases attached from going to
   Closed, which made "Done → Closed stays illegal" untrue in practice.
5. **Revenue moved period.** The reopen cleared `done_at` and Done stamped a
   new one. A September sale corrected in November left September's
   dashboard and contribution figures and landed in November's.
6. **Full scan under locks.** `retractPriceEvents` deleted by
   `ref_price_events.source`, which has no index. It ran while holding the
   source POs, the order header and the lots.
7. **Withdrawn prices left no trace.** The sale's market data points were
   deleted, and nothing recorded which ones.
8. **Sold qty never shown.** The lot change log read `d.qty`, but the `sold`
   event writes `soldQty`.
9. **Every Awaiting-payment move locked its POs.** Because only the header
   could tell a reopen apart, every Shipped/Draft → Awaiting payment move took
   the PO row locks.
10. **Untranslated history row.** The new `Sale reopened +N` row, like the
    rest of the lot change log, was hard-coded English.

## Acceptance criteria

- [x] A Done → Awaiting payment move without `from: 'Done'` is a 409 that
      changes nothing. The Reopen dialog sends `from`, and a `from` that
      doesn't match the order's status is a 409.
- [x] Only a move to Done, or a request naming `from: 'Done'`, locks the
      source POs.
- [x] Done records the lot's prior status and qty on each `sold` event
      (`priorStatus`, `priorQty`).
- [x] A reopen gives a lot back what the order actually took: never more than
      the lot had before the sale.
- [x] A sold-out lot returns to the status it had before it sold. Events
      written before this release fall back to the PO's lifecycle.
- [x] A reopen is refused while an after-sales case on the order is open.
- [x] A reopened sale can't be Closed, and its page doesn't offer Discard.
- [x] A reopen keeps `done_at`. Done again keeps the original date, so the
      sale stays in its period.
- [x] `ref_price_events (source)` is indexed.
- [x] The `reopened` event lists the market prices it withdrew, and History
      says how many.
- [x] The lot change log shows the sold qty, and its rows and labels go
      through `useT()` in English and Chinese.

## Out of scope

- A `ref_prices` row that autoTrackParts added for the sale is left tracked
  with no price after a reopen. PO intake leaves new parts in exactly that
  state for the scraper to fill. A sale's lots came through PO intake, so the
  row almost always existed before the sale.
- Closing a never-Done order that carries payments. That is how a cancelled
  deal keeps its payment and refund linked, and the release doesn't change it.

## Notes

- Found by a review of `origin/main...origin/dev` (86e7787c).
- Finding 5 reverses a note in RS-343, which moved a corrected sale to the
  month it was Done again. Contributions feed commission, so moving a sale
  out of a month already reported changes figures that may have been paid on.
