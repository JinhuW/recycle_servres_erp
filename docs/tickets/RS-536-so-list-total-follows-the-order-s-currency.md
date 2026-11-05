---
id: RS-536
title: SO list Total follows the order's currency
type: bug
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/diatom
pr: 1094
version: 1.420.1
related: []
---

## Ask

> The display here for the amount should based on the concuency i choosed in the SO.
>
> if i choosed rmb, then it should use ¥ , or $.

## Context

The Sell orders list always showed Total with `$`. `GET /api/sell-orders` returned
`total` as the USD value (`SUM(qty * unit_price)`) and the row rendered it with
`fmtUSD0`, while the order's page already showed the native total. Swapping only
the symbol would have put ¥ on a dollar figure, so the list also has to return
the amount in the order's currency.

## Acceptance criteria

- [x] A CNY order's list row shows ¥ and the native total, matching its detail page.
- [x] A USD order's row is unchanged.
- [x] Status tiles still show USD.

## Out of scope

Each of these stays in USD and is correctly labelled:

- The status tiles, which add up orders in different currencies and so need one
  common currency.
- The Excel export's Total, which has no currency column.
- `SellOrderPickerDialog`, the add-to-sell-order dialog.

## Notes

`total` stays USD on the list API because the tiles' fallback sum and the picker
read it; `nativeTotal` is new beside it, using the same expression as the detail
route.
