# Per-order Currency on Sell Orders — Design

**Date:** 2026-06-07
**Status:** Implemented
**Scope:** Let a sell order be quoted in a non-USD currency (USD + CNY), mirroring
the multi-currency vendor-bid flow. A manager picks the currency on the order;
every line is priced in it; the FX rate is frozen on the header at save.

> **Supersedes** the "SO denomination: USD-only" decision in
> [2026-05-26-multi-currency-vendor-bids-design.md](./2026-05-26-multi-currency-vendor-bids-design.md)
> (table row "SO denomination" and the "Multi-currency SO lines" out-of-scope
> item). Everything else in that design stands; this reuses its `fx_rates`
> ledger, `lib/fx.ts`, and the `source_*` audit columns.

## Decisions

| Question | Decision |
| --- | --- |
| Supported currencies | USD (base) + CNY — same `CHECK` as vendor_bids. |
| Where currency lives | Per `sell_orders` row. Every line shares the order's currency. |
| Line denomination | `sell_order_lines.unit_price` stays **USD** so all downstream reporting (dashboards, market value, list totals, xlsx export) is untouched. Native price/rate live in the line's `source_*` audit columns (added by 0056). |
| FX snapshot timing | Frozen on the header at create. Re-fetched and re-frozen on any edit that rewrites the line set or changes the currency. |
| Rate source | Reuses `lib/fx.ts` `getLatestRateToUsd` (Frankfurter + manual override ledger). |

## Data model

`apps/backend/migrations/0065_sell_order_currency.sql` — additive header columns
mirroring `vendor_bids`:

```sql
ALTER TABLE sell_orders
  ADD COLUMN currency_code  CHAR(3)       NOT NULL DEFAULT 'USD',
  ADD COLUMN fx_rate_to_usd NUMERIC(18,8) NOT NULL DEFAULT 1,
  ADD COLUMN fx_source      TEXT          NOT NULL DEFAULT 'manual';
ALTER TABLE sell_orders ADD CONSTRAINT sell_orders_currency_ck
  CHECK (currency_code IN ('USD','CNY'));
```

`fx_rate_to_usd` is the multiplier-to-USD (CNY ≈ 0.1386, USD = 1). Defaults make
the migration safe on existing rows. The line audit columns
(`source_currency`, `source_unit_price`, `source_fx_rate_to_usd`) already exist.

## Backend (`routes/sellOrders.ts`)

- **POST `/`** — accepts `currency` (default `'USD'`, unsupported → 400). The
  per-line `unitPrice` is the **native** price. Snapshots the rate once; stores
  `unit_price = convertToUsd(native, rate)` plus the `source_*` columns (null on
  USD). Header records currency/rate/source; `created` event carries them.
- **PATCH `/:id`** — accepts `currency`. A currency change requires the full line
  set (`lines required when changing currency`, 400 otherwise) because every line
  is re-priced at the fresh rate. A line rewrite without a currency change keeps
  the order's existing currency and re-snapshots the rate. `currency_code` is in
  `META_FIELDS_SO`, so a change emits a `meta_changed` event.
- **GET `/:id`** — returns `currency`, `fxRateToUsd`, `fxSource`, per-line
  `nativeUnitPrice` (= `source_unit_price ?? unit_price`), and
  `nativeSubtotal`/`nativeTotal` alongside the USD `subtotal`/`total`.
- **GET `/`** (list) — adds `currency`. Totals stay USD (they sum `unit_price`),
  so the inbox sorts apples-to-apples.
- **Promote** (`routes/vendorBids.ts`) — the SO header now inherits the bid's
  `currency_code`/`fx_rate_to_usd`/`fx_source` so a promoted CNY order's header
  matches its lines.

## Frontend

- `lib/fxRate.ts` — `fetchRateToUsd(currency)` reads `GET /api/workspace/fx-rates`
  (manager endpoint) and returns the multiplier-to-USD + the "1 USD = N CNY"
  figure for rate notes.
- `DesktopSellOrderDraft.tsx` — `CurrencyPicker` (shared USD/CNY segmented
  control) in the new-order builder. Line prices and totals render in the chosen
  currency via `fmtMoney`; a greyed USD-equivalent + rate note show for non-USD.
  Cost basis/profit stay USD (cost is USD). Save is gated until the rate loads.
- `DesktopSellOrders.tsx` — currency picker in edit mode; native line inputs and
  totals with USD-equivalent; a read-only `CNY` header badge (tooltip = rate);
  resends the line set whenever the currency toggles.
- i18n: reuses `currency.*`; adds `soUsdEquiv`, `soFxRateNote` (en + zh).

## Tests

`apps/backend/tests/sell-order-currency.test.ts` (Frankfurter stubbed):
CNY create stamps USD line value + audit cols; USD order unchanged; unsupported
currency → 400; PATCH USD→CNY re-prices, and currency-without-lines → 400.

## Out of scope

- Currencies beyond USD/CNY (single `CHECK` edit point).
- Per-line currencies (per-order only).
- Mobile sell-order views (USD-only for now).
