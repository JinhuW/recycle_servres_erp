# Multi-currency Vendor Bids — Design

**Date:** 2026-05-26
**Status:** Approved, plan pending
**Scope:** Allow vendors to submit bids in non-USD currencies on sell orders. Today everything is USD-only `NUMERIC(12,2)`. This change adds CNY (RMB) as a second accepted currency, an FX-rate ledger fed daily from a free public API with staff override, and an audit trail that preserves the original-currency facts on resulting sell-order lines.

USD remains the company's base/reporting currency. Sell-order lines themselves stay denominated in USD — the new audit columns record the source currency, source unit price, and FX rate used at promotion. This minimises blast radius: nothing downstream of sell orders (financials, dashboards, market value, history) needs to learn about currencies.

## Decisions locked at brainstorm

| Question | Decision |
| --- | --- |
| Supported currencies | USD (base) + CNY only. Enforced by a CHECK constraint; expanding later is a one-line migration. |
| Where currency lives | Per `vendor_bid` row. Every line in a bid shares the bid's currency. |
| FX source | Frankfurter (`https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY`), ECB-backed, no key. Manager-only manual override supported. |
| FX snapshot timing | Frozen on the bid at submit. Re-frozen on the SO line at promotion. Both rows recorded. |
| SO denomination | USD-only. Source currency/price/rate stored as audit columns on `sell_order_lines`. |

## Data model

One migration: `apps/backend/migrations/0056_multi_currency.sql`.

### New table — `fx_rates`

Insert-only ledger. Latest row per `(base, quote)` wins via the index. Inverse rate (`CNY→USD`) is derived (`1/rate`); never stored.

```sql
CREATE TABLE fx_rates (
  id              BIGSERIAL PRIMARY KEY,
  base_currency   CHAR(3)       NOT NULL,
  quote_currency  CHAR(3)       NOT NULL,
  rate            NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  source          TEXT          NOT NULL,           -- 'frankfurter' | 'manual'
  fetched_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  effective_date  DATE          NOT NULL,           -- ECB date the rate represents
  note            TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (base_currency IN ('USD')),
  CHECK (quote_currency IN ('CNY'))
);
CREATE INDEX fx_rates_pair_fetched ON fx_rates (base_currency, quote_currency, fetched_at DESC);
```

### `vendor_bids` — additive columns

```sql
ALTER TABLE vendor_bids
  ADD COLUMN currency_code  CHAR(3)       NOT NULL DEFAULT 'USD',
  ADD COLUMN fx_rate_to_usd NUMERIC(18,8) NOT NULL DEFAULT 1,
  ADD COLUMN fx_source      TEXT          NOT NULL DEFAULT 'manual';
ALTER TABLE vendor_bids ADD CONSTRAINT vendor_bids_currency_ck
  CHECK (currency_code IN ('USD','CNY'));
```

`fx_rate_to_usd` is the multiplier that converts a line's `offered_unit_price` to USD. For CNY this is `1/rate` (≈ `0.13858`). USD bids always store `1.0`. Defaults make the migration safe on existing rows.

### `sell_order_lines` — audit columns

```sql
ALTER TABLE sell_order_lines
  ADD COLUMN source_currency       CHAR(3),
  ADD COLUMN source_unit_price     NUMERIC(12,2),
  ADD COLUMN source_fx_rate_to_usd NUMERIC(18,8);
```

All nullable, populated only when the line came from a non-USD bid. `unit_price` remains the USD value; existing reporting is untouched.

## FX fetcher module

New file: `apps/backend/src/lib/fx.ts`. Single responsibility — keep `fx_rates` fresh and expose a small lookup API.

```ts
export type SupportedCurrency = 'USD' | 'CNY';
export const SUPPORTED_CURRENCIES = ['USD', 'CNY'] as const;

export interface FxLookup {
  rate: number;          // multiplier from quote -> USD (USD always 1)
  source: string;        // 'frankfurter' | 'manual'
  fetchedAt: Date;
  effectiveDate: string; // ISO date
}

export function listSupportedCurrencies(): readonly SupportedCurrency[];
export async function getLatestRateToUsd(sql, quote: SupportedCurrency): Promise<FxLookup>;
export async function fetchAndStoreLatest(sql, quote: SupportedCurrency): Promise<FxLookup>;
export async function storeManualOverride(sql, quote: SupportedCurrency, rate: number, opts: { userId: string; note?: string }): Promise<FxLookup>;
export function convertToUsd(amount: number, rate: number): number; // pure
```

`getLatestRateToUsd` reads the freshest `fx_rates` row for the pair; USD is a hard-coded `{ rate: 1, source: 'fixed', ... }`. If no row exists it triggers a synchronous `fetchAndStoreLatest` fallback before responding.

**Refresh cadence.** `setInterval` registered in `apps/backend/src/server.ts` startup: one boot fetch + every 6 hours. The fetcher skips when a row with `effective_date = today` already exists. Network errors log + leave the previous row in place; bid flow degrades to "slightly stale", never to "no rate". No new dependency, no external cron.

**Manual override.** `storeManualOverride` inserts a row with `source='manual'`, `created_by`, `note`. Same lookup path — most-recent wins regardless of source. Reverting an override = insert another row.

**Why a ledger.** Append-only with a `(base, quote, fetched_at DESC)` index gives free history and zero locking. Mirrors the approach already used for PO audit and SO events.

## Backend API

| Route | Change |
| --- | --- |
| `POST /api/public/v/:token/bids` (`vendorPublic.ts:91`) | Accept `currency: 'USD'\|'CNY'` (default `'USD'`). Look up latest USD→CNY rate; insert with `currency_code`, `fx_rate_to_usd`, `fx_source`. Unknown currency → 400. |
| `GET /api/public/v/:token/bids` (`vendorPublic.ts:194`) | Add `currency`, `fxRateToUsd`, `fxSource`, `usdEquivalent` to response. |
| `GET /api/public/v/:token/fx` (new, public) | Tiny endpoint returning `{ USD_CNY: number, fetchedAt: ISO }` so the vendor portal can render a live USD-equiv subtotal without authenticating. |
| `GET /api/vendor-bids` (manager list) | Add `currency`, `totalOfferedUsd` so the list sorts apples-to-apples. |
| `GET /api/vendor-bids/:id` | Add `currency`, `fxRateToUsd`, `fxSource` + per-line `unitPriceUsd`. |
| `POST /api/vendor-bids/:id/decide` (`vendorBids.ts:59`) | No body change. `acceptedUnitPrice` is interpreted in the bid's currency. |
| `POST /api/vendor-bids/:id/promote` (`vendorBids.ts:151`) | Re-fetch latest rate. Compute `unit_price = accepted_unit_price * fx_rate_to_usd`. Write `source_currency`, `source_unit_price`, `source_fx_rate_to_usd` on each SO line. Record an SO event `promoted_from_bid` with `currency`, `rate`, `source`, `effective_date` in `detail::jsonb`. |
| `GET /api/workspace/fx-rates` (new, manager) | Latest rate per pair + last 20 history rows. |
| `POST /api/workspace/fx-rates` (new, manager) | `{ quote: 'CNY', rate: number, note?: string }` → manual override row. |
| `POST /api/workspace/fx-rates/refresh` (new, manager) | Force a Frankfurter pull (Settings → FX "Refresh now"). |

Auth posture is unchanged: `vendorPublic` and the new `/fx` public endpoint stay token-only (no CSRF, no cookies); new workspace endpoints carry the standard cookie + `X-Requested-By` guard via existing middleware.

## Vendor portal UI

`apps/frontend/src/VendorApp.tsx`. One currency selector at the top of the basket; affects every line's display and the submit payload.

```
┌─ Place your bid ──────────────────────────────────────┐
│  Bid currency:  ( • USD   ○ CNY  )                    │
│                                                       │
│  RAM-DDR4-16     qty 120     [    78.00  ] CNY        │
│  CPU-i5-10k      qty  40     [   312.00  ] CNY        │
│                                                       │
│  Subtotal: CNY 21,840                                 │
│  ≈ USD 3,027 at today's rate (7.2154, 2026-05-26)     │
│                                                       │
│  Notes: [_______________________________________]     │
│                                  [ Submit bid ]       │
└───────────────────────────────────────────────────────┘
```

- Radio picker at `VendorApp` level (one currency per session/bid). Defaults to USD.
- Price input's symbol toggles `$` ↔ `¥` inline; no separate component.
- Live USD-equiv subtotal fetched once on mount via `GET /api/public/v/:token/fx`, then computed client-side. Small + greyed.
- Toggling currency keeps typed numbers; only labels and the conversion line change. Tooltip on the picker: *"Pick the currency you're quoting in."*
- Mobile flow: same picker shown as a segmented control above the qty list.

## Staff UI

### List — `pages/desktop/DesktopVendorBids.tsx:67`

- Add **Currency** column between *Vendor* and *Total*.
- *Total* shows USD-equivalent as the primary line so the list sorts apples-to-apples; native total appears small + grey below:
  ```
  $3,027        ← column "Total"
  CNY 21,840    ← small grey
  ```
- Filter chip `Currency: All ▾ (USD | CNY)`, default All.

### Detail modal — same file, lines 412–504

- Header gains a non-editable badge: `CNY · 7.2154 @ 2026-05-22 (Frankfurter)`.
- Line table keeps current *Offered Unit* column in native currency; add adjacent **USD equiv** column (read-only, derived).
- *Accepted Unit Price* input stays in the bid's currency (label updates to `Accepted (CNY)`). On blur, show USD equivalent inline as a hint.
- Promote button label becomes `Promote → SO  ($3,027 USD equivalent)` when the bid is non-USD.

### Workspace Settings → FX Rates panel (new section)

```
Workspace Settings › FX rates
─────────────────────────────────────────────
Pair      Rate      Source        Updated
USD→CNY   7.2154    Frankfurter   2026-05-25 09:00
CNY→USD   0.13858   (derived)

[ Refresh now ]   [ Override manually … ]

History (last 20):
  2026-05-25 09:00  7.2154  Frankfurter
  2026-05-24 09:00  7.2103  Frankfurter
  2026-05-22 14:12  7.2000  manual (Alex) — "pin for May invoice run"
```

Manager-only; hidden for purchasers via the existing role guard.

### Sell-order display

No change to `DesktopSellOrders` — SO lines still render in USD. The SO history timeline (already shipped) gains a row for `promoted_from_bid` that mentions the source currency, e.g. *"Promoted from bid VB-1042 — CNY 78.00 × 120 at fx 7.2154 (Frankfurter)."*

## Formatting & i18n

- New helper `fmtMoney(amount, currency)` in `apps/frontend/src/lib/format.ts`. Symbol map `{ USD:'$', CNY:'¥' }`; falls back to ISO code. Existing `fmtUSD` stays — used wherever SO totals render.
- New translation keys in `lib/i18n.tsx`: `currency.label`, `currency.usd`, `currency.cny`, `bid.usd_equivalent`, `fx.source.frankfurter`, `fx.source.manual`, `fx.refresh`, `fx.override`.

## Edge cases

- **First bid before any rate fetched.** Backend create-bid handler triggers a synchronous Frankfurter fetch as a fallback. If that also fails, returns 503 *"Currency rate unavailable, retry shortly."* In practice the boot fetch covers this.
- **Bid accepted weeks later.** The **accept-time** rate (re-fetched at promote) is what lives on the SO line. The bid's submit-time rate stays only for audit.
- **Manual override between accept and promote.** Latest row wins; same row is quoted on the SO event detail. Audit trail intact.
- **Frankfurter outage.** Refresh logs the failure; lookup falls through to the previous row. UI shows the stale `fetched_at` so staff notice.
- **USD bid.** Same code path; `fx_rate_to_usd = 1`, `fx_source = 'manual'`, no FX columns rendered in the vendor portal.

## Testing

Backend (vitest, real Postgres per `CLAUDE.md`):

1. `tests/fx-fetcher.test.ts` — mock Frankfurter via `undici` MockAgent. Assert table insert, dedupe by `effective_date`, degraded mode on 5xx (no insert, previous row remains).
2. `tests/fx-routes.test.ts` — `GET`/`POST` `/api/workspace/fx-rates` happy + auth + manager-only role. Manual override creates a new row; derived inverse returned correctly.
3. `tests/vendor-public-bid-currency.test.ts` — submit bid with `currency: 'CNY'` → row carries `currency_code`, `fx_rate_to_usd`, `fx_source`. Invalid currency → 400. Public `/fx` endpoint returns the latest pair.
4. `tests/vendor-bid-promote-fx.test.ts` — promote a CNY bid → SO line has correct USD `unit_price`, `source_currency='CNY'`, `source_unit_price`, `source_fx_rate_to_usd`. SO event records rate + source + effective date.

Frontend (sparse coverage, per `CLAUDE.md`):

5. Pure unit test for `fmtMoney(amount, currency)`.

UI is verified by visiting the vendor portal + DesktopVendorBids per the `run` skill before claiming done.

## Out of scope (deliberate YAGNI)

- Currencies beyond USD/CNY (the `CHECK` constraint is the single edit point).
- Multi-currency SO lines (audit-only path chosen).
- FX hedging, forward rates, locked corporate quarterly rate.
- Vendor-profile default currency (each bid asks).
- Re-conversion of pre-migration bids — they stay `USD/1.0/manual`.
