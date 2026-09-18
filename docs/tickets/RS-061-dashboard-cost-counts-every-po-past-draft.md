---
id: RS-061
title: Dashboard cost counts every PO past Draft
type: bug
status: in-progress
priority: P2
created: 2026-09-17
reporter: jinhu
branch: fix/dashboard-cost-all-statuses
pr:
version:
related: [RS-059, RS-051]
---

## Ask

On the production Cost card (a screenshot of it, "$141,118 · 22 purchase
orders", Purchaser tab):

> The cost should only all status PO.

Asked which figures should widen, Jinhu answered "all status beside draft",
then chose the Cost card and the chart's purchases-out bars, keeping the
leaderboard's rule.

Then, on the Sell orders card's Purchaser tab (a screenshot, "$268,059 · 12
sell orders"):

> correct me if i am wrong here, No purchaser can create sell order here

Both screenshots were pasted inline and are not on disk; the figures above
are what they showed.

## Context

RS-059 (v1.146.0) built the Cost card and the cashflow chart's down-bars on
the leaderboard's rule — `lifecycle IN ('ready_to_pay', 'done')`, the point
at which commission is owed.  That rule is right for commission and wrong
for spend: a PO that is In Transit or Reviewing is money already committed,
and a manager looking at "Cost" for the month wants to see it.

The Sell orders and Profit cards' Purchaser tab groups each sold line by the
purchaser whose PO supplied the units (`sell_order_lines.inventory_id →
order_lines → orders.user_id`), the same attribution as the leaderboard's
revenue and profit columns.  Jinhu is right that purchasers never create
sell orders — every `/api/sell-orders` write is manager-only — so the tab's
name misread as "who created the sell order".  The grouping is useful; the
label is not.

## Acceptance criteria

- [ ] The Cost card and the chart's down-bars sum every PO with
      `lifecycle <> 'draft'` (In Transit, Reviewing, Ready to Pay, Done) in
      the window, by `created_at`; the chart's cost series sums to the Cost
      card's total.
- [ ] The purchaser lens's Cost card follows the same rule over the caller's
      own POs; its Sell orders and Profit cards (projected) still count only
      Ready to Pay and Done.
- [ ] The leaderboard's Total cost column and ranking are unchanged
      (Ready to Pay and Done).
- [ ] The Purchaser tab on the Sell orders and Profit cards reads "Sourced
      by" (zh: 采购来源), including its column header and "Remaining" row;
      the Cost card's tab still reads "Purchaser".
- [ ] `en` and `zh` in parity.

## Out of scope

- Widening the leaderboard's Total cost — it is the commission basis
  (RS-051, v1.132.0).
- KPI tiles and the projected revenue/profit cards — a margin set on an
  unreviewed PO is not yet a projection anyone signed off.
- Excluding archived POs — no dashboard query does (RS-051).

## Notes

- `ticket.sh` allocated RS-061 because a sibling session had already taken
  RS-060 on `origin/dev`.
