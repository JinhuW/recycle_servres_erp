---
id: RS-249
title: Bank payments link to a sell order or a PO's commission
type: story
status: done
priority: P2
created: 2026-10-13
reporter: jinhu
branch: feat/payments-link-so-commission
pr: 637
version: 1.257.0
related: [RS-200, RS-185, RS-086, RS-010]
---

## Ask

> 1. The payment should also able to link with a SELL order.
> 2. The payment can also link with a PO commission fee.

## Context

The manager-only Payments page reconciles Mercury and PayPal rows against
purchase orders only: `bank_transactions.order_id` is the single link target
(v1.90.0), and every "is this row open" predicate, the three CHECKs on the
table and the PO's paid figure (`linkedPaid`, RS-200) are keyed on it. Money a
buyer sends for a sell order has no home on the page, and a purchaser's
commission payment can only be linked to the PO as if it were cost money,
which makes the PO read as over-paid and fires the payment-gap banner.

A row now links to one of three targets: a purchase order's cost (as before),
a purchase order's commission (`link_kind = 'commission'`), or a sell order
(new `sell_order_id`, migration 0176). Cost figures never count a commission
link. The new targets are picked by search (recent candidates, id, customer
or purchaser); the amount/date matcher stays purchase-order cost only.

## Acceptance criteria

- [x] Link… offers Purchase order, Commission and Sell order targets; the
      Sell order tab opens first on an incoming row.
- [x] A row linked to a sell order shows the SO pill and its total; the
      sell-order page lists its linked payments with the net received.
- [x] A commission link shows the PO pill with a Commission chip; the PO's
      Commission box lists it; the Cost Payment ledger, `linkedPaid` and the
      payment-gap banner ignore it.
- [x] Unlink, group/ungroup, ignore, assign and transfer guards treat all
      three link kinds alike; pairing carries a sell-order link onto the
      sibling leg.
- [x] `#/payments/so/<id>` pins the page to that sell order;
      `#/payments/po/<id>` shows the PO's cost and commission rows.
- [x] Backend tests cover link, unlink, ledger and stats for both new targets.

## Out of scope

- Amount/date matching and auto-link for sell orders and commissions (a sell
  order carries no PayPal transaction id).
- A "paid" status or a payment-gap warning on sell orders.
- The phone shell: the Payments page and the ledgers are desktop surfaces.
- Activity events for links — a PO cost link writes none today either.

## Notes

- Plan: `~/.claude/plans/expressive-inventing-quasar.md`.
- "Linked" is `linked_at IS NOT NULL`; the CHECKs make that equivalent to
  exactly one of `order_id` / `sell_order_id` being set.
