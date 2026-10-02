---
id: RS-150
title: "Reporting money: sales dated by Done, purchased-qty basis, lot-price cost, customer tiles, supplier rollups"
type: bug
status: done
priority: P2
created: 2026-10-02
reporter: jinhu
branch: fix/reporting
pr: "#468"
version: 1.198.0
related: [RS-064, RS-068, RS-107, RS-146]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

This is Batch 7a of the approved plan,
`docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`, covering
review findings M24–M27 and the RS-107 supplier-rollup follow-up. The
supplier match key (M28) and bank pairing (M20–M23) are Batch 7b.

## Context

- **M24:** sales were dated by `sell_orders.updated_at`
  (`dashboard.ts`, `services/contributions.ts`), which every later edit
  moves.
- **M25:** the purchaser projections multiplied by `ol.qty`, which a partial
  sale decrements, so a sale lowered the commission a purchaser was shown.
  The supplier items list had the same problem.
- **M26:** the manager's realized cost used `effUnitCost` (line cost plus fee
  share). A negotiated lot price never entered it, so a $950 lot over a $100
  line read as a $50 profit. The PO page's Realized column (RS-064/068)
  already used `paidUnitCost`.
- **M27:** customer `lifetime_revenue` counted Draft and Closed orders, and
  `outstanding` was "not Done".
- **RS-107 follow-up:** a purchaser's client card summed every user's POs at
  that client.

## Acceptance criteria

- [x] Migration 0150 adds `sell_orders.done_at`, with its index and a
      backfill (status event, then the Done evidence row, then
      `updated_at`). The status route sets it on Done. Reporting windows and
      buckets read it.
- [x] Manager realized cost and profit use `paidUnitCost`; commission stays on
      `effUnitCost`.
- [x] Purchaser projections and the supplier items list use
      `COALESCE(qty_purchased, qty)`.
- [x] Customer revenue counts Done orders only; outstanding counts Shipped and
      Awaiting payment.
- [x] For a purchaser, spend, PO count, rhythm, gap and items on a supplier
      cover only their own POs. The tier score stays company-wide.

## Out of scope

- Batch 7b: the supplier name key and the bank pairing and currency fixes.

## Notes

- `dashboard-contrib.test.ts` now expects −$740 realized profit, not $110. Its
  fixture prices PO-CT-1 at a $950 lot over one $100 line, and the old
  figure ignored that.
