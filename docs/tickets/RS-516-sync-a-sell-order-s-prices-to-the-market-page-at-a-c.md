---
id: RS-516
title: Sync a sell order's prices to the Market page at a chosen percent
type: story
status: done
priority: P2
created: 2026-11-03
reporter: jinhu
branch: JinhuW/tilefish
pr: 1072
version: 1.414.0
related: []
---

## Ask

> When it auto fill the marketplace price. It should ask me an discount.
>
> for example, 90% of the sell price will auto sync to the marketplace

> But do not note in any market place about this discount

> It is all about the apporach to update the sell price in the marketplace.

## Context

A vendor's filled bid sheet on a sell order opens *Review imported prices*.
Until now, Fill + Save also wrote each confirmed part to the Market page at the
full price (`recordBidDataPoints`, source `bid:<order>`, restored in v1.402.0
by RS-497). The owner wants the Market sell price (`ref_prices.last_price`)
updated at a percent they are asked for, and wants that update apart from
filling the order.

## Acceptance criteria

- [x] Fill + Save no longer writes anything to the Market page.
- [x] An editable sell order has a manager-only **Sync to Market** button, disabled with a reason while the order has unsaved changes, because it uses saved prices.
- [x] The button opens a dialog with a percent field (above 0, up to 100, decimals allowed), starting at the last-used percent or 90, saved per user on confirm.
- [x] The dialog lists the order's priced parts with a checkbox, order price and resulting Market value, updating as the percent is typed. Lines at qty 0, or with no part number or a 0 price, are not listed.
- [x] Confirming writes each checked part at qty-weighted avg × percent, rounded to 2 decimals, immediately and without a Save. Order lines and totals don't change.
- [x] Syncing a part again replaces this order's earlier reading for it.
- [x] Closing the order still withdraws its readings (RS-508), and Done still records the full `sale:<order>` price.
- [x] Nothing on the Market page, its Activity feed or any market API mentions the discount: `note` is null and the source stays `bid:<order>`.
- [x] A bad percent or an empty part list returns 400, a non-manager gets 403, and a Done or Closed order gets 409.

## Out of scope

- The Market page's own spreadsheet import and Review mode's PO import.
- Discounting the Done reading. The owner first asked for it, then chose a
  separate sync with nothing stored on the order, so reaching Done moves the
  Market price up to the full sale price.
- Changing past readings.
- An entry in the order's history for a sync.

## Notes

Plan: `~/.claude/plans/validated-spinning-salamander.md` (session-local).

The RS-508 rule that a part typed over after an import isn't recorded as a bid
went away with `bidParts`: the sync records saved prices the manager picks in
the dialog, whichever way they got there.
