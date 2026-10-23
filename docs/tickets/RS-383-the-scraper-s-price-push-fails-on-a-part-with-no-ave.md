---
id: RS-383
title: The scraper's price push fails on a part with no average yet
type: bug
status: done
priority: P1
created: 2026-10-23
reporter: jinhu
branch: fix/market-write-null-trend
pr:
version: 1.329.1
related: [RS-364]
---

## Ask

> yes. go ahead

This answered: "Should I open a ticket to fix the `trend` bug?" RS-364 had
reported it. `lib/marketWrite.ts` writes `ref_prices.trend = NULL` when a part
has no previous average price, and that column is NOT NULL.

## Context

The scraper pushes prices to `POST /api/market/values` with a `market:write`
bearer (`routes/market.ts`), and `applyMarketWrites` in
`lib/marketWrite.ts` applies them. Since that endpoint landed (`aa0c1173`,
2026-05-22), it has computed `trend` like this:

```ts
const trend = idRow.prev_avg === null ? null : +(avg - idRow.prev_avg).toFixed(2);
```

That line has two bugs:

- **NULL into a NOT NULL column.** `ref_prices.trend` is
  `REAL NOT NULL DEFAULT 0` (`0001_init.sql`), and no later migration
  relaxed it. A part with no `avg_sell` makes the UPDATE throw. The batch
  runs in one transaction, so the throw rolls back every row in it and the
  scraper gets a 500. Parts auto-tracked from PO intake
  (`lib/marketAutoTrack.ts`) are created with no prices.
- **The wrong unit.** It stores a dollar difference, so 120 → 130 is stored
  as `10`. The Market page reads `trend` as a fraction and shows it ×100 as
  a percent (`TrendBadge` in `DesktopMarket.tsx`, and `Market.tsx`). The
  seed writes fractions as well. Once the first bug is fixed, a $10 rise
  would show as "+1000.0%".

The Railway `dev` DB is last night's scrubbed copy of prod. A read-only
query against it on 2026-10-23 showed that the feed is completely down:

- All 1,262 `ref_prices` rows are `auto-intake` with `avg_sell` NULL.
- `ref_price_events` has never held a `scraper:` event. The others are
  1,321 `sale`, 485 `bid`, 461 `mcp` and 121 `import`.
- Every `trend` is 0, so no stored value needs repair.

## Acceptance criteria

- [x] A push to a part with no `avg_sell` updates it (200, `updated: 1`) and sets `trend` to 0.
- [x] A batch that includes such a part still updates the other rows in it.
- [x] A push to a part with a previous average sets `trend` to the change as a fraction of that average, to 3 decimal places (120 → 132 gives 0.1). This matches what the Market page and the seed assume.
- [x] A previous average of 0 gives `trend` 0, not a division by zero.
- [x] `market-write.test.ts` covers all three cases.

## Out of scope

- The Market page's column header "12-week sell trend". The value is the
  change since the scraper's previous push, not over 12 weeks.
- Tightening `lib/market.ts`'s `trend: number | null` type to match the
  column.
- The dead columns that RS-364 recorded.

## Notes

- `avg_sell` is `numeric`, and postgres.js returns `numeric` as a string. So
  `prev_avg` was a string typed as a number, and the subtraction worked only
  through JS coercion. The SELECT now casts it to `float8`.
