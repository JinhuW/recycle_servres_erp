---
id: RS-323
title: Review mode prices the PO for the commission
type: story
status: in-progress
priority: P2
created: 2026-10-19
reporter: jinhu
branch: review-mode-selling-price
pr:
version:
related: [RS-124, RS-128, RS-191]
---

## Ask

> Enhance the review mode, it should not only for the package check, but also used for filling the selling price for calculating the commision fee.
>
> I think we can drop our sell order spreadsheet and it will auto fill the sell price.
>
> /frontend-design:frontend-design enhance the UIUX

## Context

Review mode (`#/purchase-orders/<id>/check`, `DesktopBoxCheck.tsx`) is where a
manager counts a PO against the box and approves it for payment. The
commission the purchaser is paid is `(revenue − cost) × rate`, and revenue is
the manager-set **Sell / Unit** on each line (`order_lines.sell_price`, the
projection the dashboard, the leaderboard and the PO workbook all read).
Until now that price was typed on the PO page, line by line through the
drawer, after the count — or, in practice, kept in a separate sell-order
spreadsheet and copied over. Review mode never showed a price at all.

What exists already and is reused, with no new backend surface:

- `PATCH /api/inventory/:lineId { sellPrice }` — manager-only, writes the
  price at any stage short of archived (the PO page uses it at Ready to Pay
  since v1.191.1), logs a `priced` inventory event and returns
  `sub_cost_sell` / `low_margin` warnings.
- `POST /api/market/lookup` — the Market board's value per part number:
  last price, average sell, and the team's own 30-day average
  (`useMarketLookup`, `MarketAssist`'s "Suggested sell").
- `PATCH /api/orders/:id { commissionRate }` — manager-only, not a material
  edit, refused once the book closes at Ready to Pay.
- The Commission tab's maths (`DesktopEditOrder` → `CommissionTab`), which
  `lib/reviewPricing.ts` now reproduces as a pure function.

## Acceptance criteria

- [x] Each Review mode row has a **Sell / Unit** field beside the count. Enter
      or leaving the field saves it through the inventory line PATCH; Escape
      restores it; a blank saves "unpriced". The figure shows at once and is
      put back with a toast if the server refuses it.
- [x] An unpriced line whose part number has a market value shows that value
      as a ghost suggestion in the field (last price, else average sell, else
      the team's 30-day average). Enter on the empty field accepts it, and a
      *Use* link under the field does the same.
- [x] **Fill from market** in the tally bar prices every unpriced line that
      has a suggestion, in one click, and says how many it priced.
- [x] A priced row shows its margin under the price; a price below cost reads
      red and the save toasts a warning.
- [x] The tally bar gains a pricing half: *n / m priced* with its own meter and
      the live **Purchaser earns** figure, computed as the PO page's Commission
      tab does (goods or lot price + fees, revenue over priced lines, rate,
      self-pay reimbursement) and over the qty Approve will leave.
- [x] A **Commission** card in the side panel shows the rate (editable at
      Reviewing and earlier, read-only once the book is closed), revenue,
      cost, profit, commission and the total the purchaser earns, with the
      unpriced count.
- [x] The Compare card shows the selected product's sell price, its market
      reference (basis, age, the team's 30-day average) and, once sold, the
      final sell price.
- [x] Finish review lists the products still without a sell price and states
      that they count as $0 in the commission. Approve is not blocked by them.
- [x] Lowercase `p` focuses the selected row's price field; the key legend
      says so. Scanners still land in the scan box.
- [x] Archived POs show every price read-only.
- [x] `lib/reviewPricing.ts` is unit-tested: the suggestion order, the money
      maths against a lot price, fees and self pay, and the pricing tally.

## Out of scope

- Writing the sell order itself from Review mode. The sell price here is the
  PO line's projection that feeds commission, as it always was; actual sales
  still go through sell orders.
- Blocking Approve on unpriced lines. Short lines don't block it either; the
  Finish card says what is unpriced and the PO page can still fix a price at
  Ready to Pay.
- A phone version. Review mode is desktop-only.
- Changing the commission formula or the market basis rule.

## Notes

- The money figures are computed over the qty Approve will leave — a line
  ticked at 0 contributes no revenue and, when the goods total follows the
  lines, no cost — the same rule `reviewApproveTotal` uses for the payment
  gap, so the two never disagree on the same screen.
- Prices save one line at a time, directly on commit, not through the count's
  debounced queue: a price is typed deliberately, the count is scanned in
  bursts.
