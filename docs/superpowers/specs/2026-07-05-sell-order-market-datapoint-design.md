# Record a market data point when a sell order completes

## Problem

The Market Value board (`ref_prices`) is fed by two sources today: the scraper
(`applyMarketWrites` → `low/high/avg_sell/samples`) and manual entry from the
Market page (`POST /market/:id/manual-price` → `appendPriceEvent`). Neither
captures our own realized sales. When a sell order is completed the price we
actually transacted at — the single most authoritative signal we have for a
part's value — is thrown away. We want each completed sale to leave a data
point on the sold part's market record.

## Trigger

The completion event is the sell-order status transition to **`Done`**, handled
in `POST /api/sell-orders/:id/status` (`apps/backend/src/routes/sellOrders.ts`,
the `if (body.to === 'Done')` block). Recording happens there, after the
existing stock-consumption + notification writes, **inside the same
`sql.begin` transaction**.

- `Closed` (lost/cancelled deal) does **not** record — there is no real
  transacted price.
- The transition is already guarded (`FOR UPDATE` row lock + idempotent
  short-circuit when `cur.status === body.to`), so recording runs exactly once
  per real Done transition; no extra idempotency work is needed.

## What gets recorded

A data point is a `ref_price_events` row plus the denormalized `last_price*`
columns on `ref_prices`, written through the existing `appendPriceEvent(tx, …)`
helper — the same path the Market page's manual-price button uses. Scraper-owned
aggregates (`avg_sell` / `low_price` / `high_price` / `samples`) are **not**
touched; the two data sources stay separate.

### Price basis — already USD

`sell_order_lines.unit_price` is stored in **USD**. Per migration
`0065_sell_order_currency.sql`, a sell order is quoted in one currency but each
line's USD value lives in `unit_price`; the native price is retained separately
in `source_unit_price` / `source_currency`. So no FX conversion is required —
`unit_price` is recorded directly. `ref_prices` is USD-denominated, so the
values are directly comparable.

### Per-product rollup

Within one order the same part may appear on multiple lines (e.g. split across
warehouses or conditions). We record **one data point per distinct product per
order**, priced as the **qty-weighted average of `unit_price`** across that
product's lines:

```
price = Σ(unit_price_i · qty_i) / Σ(qty_i)   over lines sharing a canonical PN
```

Rationale: one deterministic `last_price` per product per sale, and no cluster
of near-identical events. "Same product" uses the existing **canonical part
number** rule (strip a leading `P/N`/`S/N`/`PART` prefix, drop whitespace,
upper-case) — the same rule `autoTrackParts` and `applyMarketWrites` match on.

### Lines with no part number

Skipped. Without a part number there is no product on the board to attach the
data point to. (These are rare — inventory-backed lines always carry a PN.)

## Ensuring the product row exists

A sold part may have no `ref_prices` row — e.g. a manually-added sell-order line
for a part that never went through PO intake auto-tracking. Before recording we
ensure the row exists via the existing **`autoTrackParts(tx, parts)`** (idempotent:
dedupes by canonical PN, inserts only the missing ones with price columns NULL).

**Change to `autoTrackParts`:** extend `TrackablePart` with optional `label`
and `subLabel`, and have `autoTrackParts` insert them when present (falling back
to the current `synthLabel(...)` / part-number behavior when absent). Reason:
`sell_order_lines` carries a real `label`/`sub_label` but none of the spec
fields (`brand`/`capacity`/…), so without this an auto-created row's label would
degrade to the bare part number. The PO-intake caller passes no label and is
unaffected. The new column list stays within the existing INSERT.

## Flow (inside the Done transaction)

1. Load the order's `sell_order_lines`: `part_number`, `unit_price`, `qty`,
   `category`, `label`, `sub_label`.
2. Drop lines with an empty/whitespace `part_number`.
3. Group remaining lines by canonical PN; compute the qty-weighted average
   `unit_price` per group and keep the first line's `category`/`label`/`subLabel`
   for the auto-create path.
4. `autoTrackParts(tx, groups)` to guarantee a `ref_prices` row per canonical PN.
5. One SQL query mapping each canonical PN → `ref_prices.id` (reusing the same
   `REGEXP_REPLACE`-based canonicaliser `autoTrackParts` uses).
6. For each group, `appendPriceEvent(tx, { refPriceId, price: avgUsd,
   source: 'sale:' + <sellOrderId>, note: null, actorUserId: u.id })`.

## Atomicity

All of the above runs inside the existing Done `sql.begin`. Either the sale
completes and every data point lands, or the whole transition rolls back —
consistent with how `autoTrackParts` already runs inside the PO-create
transaction. The recording is deterministic, low-risk SQL (match + insert +
update); its realistic failure mode is the database being unavailable, in which
case the transition would fail regardless.

(Considered and rejected: recording best-effort in a separate transaction after
commit so a market-write hiccup can't block a sale close. Rejected for
codebase consistency and because the atomic guarantee — every completed sale has
its data point — is worth more here than insulating the close from an
essentially DB-down-only failure.)

## Result on the Market page

Each sold product's row shows the sale as the newest point in `recent_prices`
and as `lastPrice` / `lastPriceAt` with `lastPriceSource = "sale:SO-…"`,
alongside existing scraper and manual data. No frontend change is required —
the Market surface already renders `recent_prices` and `last_price*`.

## Testing

Backend integration tests (real Postgres, `apps/backend/tests/`):

- **Happy path:** create a sell order for a tracked part, transition to Done,
  assert one new `ref_price_events` row with the line's `unit_price` and source
  `sale:<id>`, and that `ref_prices.last_price` / `last_price_at` /
  `last_price_source` updated.
- **Qty-weighted rollup:** two lines, same PN, different prices/quantities in one
  order → exactly one event at the qty-weighted average.
- **Auto-create:** sold part with no prior `ref_prices` row → row is created
  (label from the line) and the event recorded against it.
- **CNY order:** order in CNY → recorded price equals the line's USD
  `unit_price` (not the native `source_unit_price`).
- **No part number:** line with null part_number → no event, no error.
- **Closed, not Done:** transition to `Closed` → no data point recorded.
- **No aggregate mutation:** `avg_sell` / `low_price` / `high_price` / `samples`
  are unchanged after a Done.

## Out of scope

- No schema/migration change (reuses `ref_prices` / `ref_price_events`).
- No change to scraper aggregates or the internal-sales (projected `sell_price`)
  computation.
- No new frontend work.
