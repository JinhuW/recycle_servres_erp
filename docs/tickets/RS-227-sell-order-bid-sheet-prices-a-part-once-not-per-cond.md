---
id: RS-227
title: Sell-order bid sheet prices a part once, not per condition
type: story
status: done
priority: P2
created: 2026-10-11
reporter: jinhu
branch: feat/bid-price-no-condition
pr: 601
version: 1.242.0
related: []
---

## Ask

> remove the condition from the sell order bid price.

## Context

The vendor bid sheet (`GET /api/sell-orders/:id/price-template`) printed a
Condition column and split a part into one row per condition, so a vendor
priced New and Used separately. The price import matched rows back by
part number plus that condition, and the confirmed bid was recorded per
(part, condition).

## Acceptance criteria

- [x] The bid sheet has no Condition column.
- [x] A part on the order in two conditions prints as one bid row, its qty
      summed.
- [x] Importing a filled sheet matches by part number alone; the price applies
      to every line of that part, whatever its condition.
- [x] The import preview no longer shows a condition.
- [x] Packing lists and the order's product `#`s are unchanged.

## Out of scope

- The condition on the sell-order lines themselves, the order page and the
  packing checklists: only the bid price stops depending on it.

## Notes

- `bidParts` keeps its `{ partNumber, condition }` shape on the API; the client
  now always sends `condition: null`, which already meant "every line of the
  part" to `recordBidDataPoints`.
