---
id: RS-448
title: Show the sell price on the mobile Market value page
type: bug
status: done
priority: P2
created: 2026-10-28
reporter: jinhu
branch: JinhuW/sculpin-2
pr: 985
version: 1.377.3
related: []
---

## Ask

> pls show the sell price in this page as well.

(Sent with a phone screenshot of the mobile Market value page: each card shows
MAX BUY ≤ $105.86 and the like, with a lone green "–" where a price should be.)

## Context

The mobile Market value page (`apps/frontend/src/pages/Market.tsx`) put
`avgSell` in each card's top-right slot. Most reference prices have no
`avg_sell`, so the slot showed "–". Max buy still had a value because
`formatRefPrice` (`apps/backend/src/lib/market.ts`) derives it from
`last_price ?? avg_sell`. `last_price` is the figure the desktop page shows as
"Last sell price". The phone already received `lastPrice` in the `/api/market`
payload but never displayed it.

## Acceptance criteria

- [x] Each card shows a labelled sell price, `lastPrice ?? avgSell`. That is
      the figure Max buy is derived from, so Max buy is always 70% of it.
- [x] A SKU with neither price still shows "–".
- [x] The expanded card adds an "Avg sell price" row when `avgSell` is present
      and differs from the headline price.
- [x] EN and ZH strings.

## Out of scope

Backend or API changes, because the data is already sent. The desktop Market page.
