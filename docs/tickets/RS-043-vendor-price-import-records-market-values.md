---
id: RS-043
title: Vendor price import records market values
type: bug
status: in-review
priority: P2
created: 2026-09-12
reporter: Jinhu
branch: fix/price-import-market-value
pr:
version: 1.138.3
related: []
---

## Ask

> Fix the bug that when user upload a price template, it does not update the
> market value accorandly.

(With a screenshot of the Vendor price import section on SO-4048's edit
modal: the three-step download / fill / drop panel, and the order summary
showing ¥688,694.45.)

## Context

The vendor price round-trip (v1.21.0) is write-free on the server by design:
`POST /api/sell-orders/:id/price-import/preview` parses the bid sheet and
reports how its rows match the order; confirming the preview fills the edit
form's price inputs, and the manager saves through `PATCH /:id`.

"Market value" is the app's name for the `ref_prices` board (the Market value
page, the `get_market_value` MCP tool).  Its "Last sell price" column is
`last_price`, and the only sell-order path that writes it is
`recordSaleDataPoints`, which runs on the **Done** transition (spec
`docs/superpowers/specs/2026-07-05-sell-order-market-datapoint-design.md`).

So a bid sheet's prices never reached the board until the order closed.  Prod
shows exactly that: SO-4048 (Draft, CNY, 135 lines) had its lines edited at
2026-09-12 21:02 UTC — the import and save, two minutes before this request —
and `ref_price_events` in prod carries only `sale:` and `mcp` sources.  For a
135-line CNY deal, Done can be weeks away; the customer's accepted quote is a
market signal now.

## Acceptance criteria

- [x] Saving an edit after a confirmed price import writes one
      `ref_price_events` row per confirmed product (canonical part number),
      source `bid:<SO id>`, and bumps `ref_prices.last_price*` — creating the
      `ref_prices` row when the part is not tracked yet.
- [x] The recorded price is USD at the rate the lines were saved at, CNY
      orders included; several lines of one product roll up qty-weighted, as
      the Done data point does.
- [x] A plain price edit with no import records nothing.
- [x] Done still records its own `sale:` data point.
- [x] An import that is applied and then discarded (the modal closed without
      saving, or the save rejected) records nothing.
- [x] Done and Closed orders keep refusing line edits, so no bid can land on
      a closed deal.

## Out of scope

- Writing the board at confirm time, before Save.  The prices do not exist
  on the order until Save either, and a confirm-time write needs its own FX
  lookup and leaves a data point behind when the edit is cancelled.
- A "bid" badge on the Market value page; the source string is visible on
  the Activity page.
- The scraper aggregates (`avg_sell`, `low_price`, `high_price`, `samples`)
  stay untouched, as the sale-datapoint spec decided.

## Notes

- Plan: `~/.claude/plans/silly-gathering-truffle.md` (plan-first, one
  reviewer).  The reviewer moved the design from a new
  `price-import/apply` endpoint to a `bidParts` field on the existing PATCH:
  one write owner, the same FX rate the lines are saved at, no orphan point
  on a cancelled edit, and the rollup matches the lines actually saved.
- A bid is not a realised sale, but it lands in the same `last_price` the
  "Last sell price" column shows.  That is the ask; the `bid:` source keeps
  it distinguishable, and the Done `sale:` point overwrites it when the deal
  closes.
