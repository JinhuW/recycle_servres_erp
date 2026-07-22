# Negotiated Final Price Adjustment — Design

**Date:** 2026-07-22
**Status:** Implemented

## Problem

Sell orders are quotes; buyers counter-offer one final number ("¥9,500 instead
of ¥10,000"), often after the order has left Draft — when the editor is
read-only. There was no way to record the negotiated price short of reopening
the order and retyping every line, and nothing in the UI showed that a price
had been adjusted.

## Decisions (user-approved)

1. **One number in, prorated across lines.** The manager types the negotiated
   final total (native currency). The server scales every line's unit price
   proportionally, preserving the 0036 invariant (`total === Σ qty·unit_price`,
   no stored total/discount) and keeping per-part market datapoints honest.
2. **Adjustable until Done.** Allowed in Draft / Shipped / Awaiting payment;
   409 at Done / Closed. (`ADJUSTABLE_STATUSES` in `routes/sellOrders.ts`.)
3. **Badge-only audit.** No reason dialog. The Total box shows the original
   total struck through, the negotiated total, and an "Adjusted −X%" chip with
   who/when in the tooltip; a `price_adjusted` event lands in the immutable
   `sell_order_events` timeline; list rows get a small marker.

## Semantics

- **Achieved vs typed total.** Unit prices are NUMERIC(12,2), so a line's
  total moves in 0.01·qty steps and the typed target may be unreachable. The
  proration (`services/sellOrderPriceAdjust.ts`, integer-cents,
  floor + largest-remainder, deterministic) returns the closest reachable
  total at or below the target; that **achieved total is the truth** — the
  endpoint returns it and the UI re-fetches rather than trusting the input.
  Zero-price lines are never touched.
- **Baseline rule.** `sell_orders.pre_adjust_native_total` is set only by the
  *first* adjustment; `adjusted_at` / `adjusted_by` track the latest. The badge
  always compares first-quoted vs current; each adjustment appends its own
  event with `{fromTotal, toTotal, requestedTotal, currency, pct}`.
- **Reset on line rewrite.** A PATCH that rewrites `lines` clears all three
  columns — a re-typed line set invalidates the old baseline, and a stale
  "Adjusted" badge would lie. Notes/customer/receiver-only PATCHes keep it.
  Events survive (append-only table).
- **Currency.** Proration runs on native prices (`source_unit_price ??
  unit_price`); USD line values are re-derived at the header's frozen
  `fx_rate_to_usd`. Lines are updated **in place** (ids, positions,
  serial/chip snapshots preserved).
- **Market datapoints** need no change: `recordSaleDataPoints` reads line
  prices at Done, which now carry the negotiated values.

## Surface

- Migration `0075_so_price_adjustment.sql` — three header columns + FK index.
- `POST /api/sell-orders/:id/adjust-price` — manager-gated, `FOR UPDATE`,
  status-guarded; body `{ targetTotal }`; returns `{ ok, achievedTotal }`.
- `GET /:id` → `order.priceAdjustment`; `GET /` rows → `adjusted: boolean`.
- Frontend (revised same-day, v1.23.0): an **order-summary card** with
  `Subtotal / Adjustment / Total` breakdown rows (signed delta, colored, pct
  chip with who/when tooltip) replaces the original strikethrough treatment.
  "Adjust total" lives in the card head and is **never disabled**:
  - **View modal** — applying calls `adjust-price` immediately (order is
    otherwise read-only there).
  - **Edit modal** — the target joins the draft (`pendingAdjust`) like any
    other edit and is applied on **Save**. Save sequencing is
    `PATCH → adjust-price → status POST`: proration must run on the saved
    line set, and a `Done` transition must see negotiated prices (it consumes
    stock + records market datapoints). Subtotal tracks the live draft while
    the buyer's target stays fixed; an (×) removes the pending adjustment;
    a saved adjustment's rows hide once the draft's priced set diverges
    (PATCH clears the baseline on save anyway).
  i18n keys `soAdjust*` / `soOrderSummary` / `soSubtotalRow` /
  `soAdjustmentRow` / `historyPriceAdjusted` (EN + ZH).

## Tests

`apps/backend/tests/sellOrder-price-adjust.test.ts` — pure proration cases
(exactness, determinism, gap bound, zero-price, markup) plus endpoint guards
(403/404/409/400), USD + CNY paths, repeated-adjustment baseline, PATCH reset,
GET payload, and the Done → market-datapoint flow.
