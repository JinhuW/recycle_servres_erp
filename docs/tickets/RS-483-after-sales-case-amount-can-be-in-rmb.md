---
id: RS-483
title: After-sales case amount can be in RMB
type: story
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: JinhuW/rorqual
pr:
version: 1.395.0
related: []
---


## Ask

> The after sell allow rmb here.

(With a screenshot of the New after-sales case page, SO-4038, the "Amount (USD)" field.)

> also move the issue to the resolution section.

(With a screenshot of the Issue card.)

## Context

A case's refund or discount was USD only: `after_sales_cases.amount` (migration
0175) is documented as USD, the form labels it "Amount (USD)", and every list,
detail and tile formats it with `fmtUSD`. Sell orders have been USD or CNY since
0065, and many after-sales customers are Chinese buyers who are refunded in RMB,
so the manager had to convert by hand. Accounting's after-sales target also
hard-coded `currency: 'USD'`.

## Acceptance criteria

- [x] Case form (new and detail) has a USD / RMB currency choice beside Amount; a new case defaults to the loaded sell order's currency.
- [x] The amount is saved in the chosen currency, and list, detail and the sell order's cases panel show it with ¥ or $.
- [x] Status tiles still total in USD, converting RMB cases at the ledger rate of the case's day.
- [x] Accounting's after-sales target reports the case's own currency.
- [x] Existing cases stay USD.
- [x] The Issue field sits in the Resolution card on the new-case form and the case page.

## Out of scope

- Currencies beyond USD and CNY.
- Freezing a per-case FX rate; tiles convert at the ledger's rate for the day the case was opened.
- Converting amounts on existing cases.

## Notes

- The second ask arrived mid-implementation and was folded into this ticket.
- Migration `0220_after_sales_currency.sql` adds `after_sales_cases.currency_code`
  (USD|CNY, default USD); `amount` is native to it. POST defaults it to the sell
  order's `currency_code`; PATCH logs a change as `currency_code` in the timeline.
- Case line unit prices stay USD: they are snapshots of `sell_order_lines.unit_price`.
