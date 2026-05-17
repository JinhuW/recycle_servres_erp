# Per-order commission rate — design

**Date:** 2026-05-17
**Status:** Approved (brainstorming) — pending spec review

## Goal

Remove every existing commission mechanism and replace them with a single
commission rate stored on each order, set by a manager in the PO (order)
detail screen. Commission everywhere is `profit × order rate`.

## Background — what exists today (all removed)

Three independent mechanisms coexist in the codebase:

1. **Tiered model** — `commission_tiers` table + `src/lib/commission-calc.ts`
   (`computeCommission`: margin % → tier → rate). Powers the dashboard KPI,
   leaderboard, and `GET /api/commission/preview`.
2. **Payment-type rules** — the Settings → Commission panel titled
   "Commission rules" (`commission_settings.rate_company` / `rate_self`),
   served by `/api/commission/settings`.
3. **Per-user default rate** — `users.commission_rate` (`NUMERIC(5,4)
   NOT NULL DEFAULT 0.075`), surfaced per order by `GET /api/orders` as
   `commissionRate` and used by the frontend to display each order's
   commission; plus a hardcoded `0.075` in `me.ts` (Profile lifetime stats).

The other `commission_settings` keys (`pay_schedule`, `manager_approval`,
`hold_on_returns`, `draft_mode`) are dead — created by migration 0015 and
read nowhere — so the whole table goes.

## Decisions (locked during brainstorming)

- Remove **all three** mechanisms. The only commission input is a per-order
  rate set by a manager in the PO detail.
- A new order has **no rate** (`NULL`) → counts as **$0** commission until a
  manager sets one. No default anywhere.
- **Existing orders are zeroed** on migration (`commission_rate = NULL`).
  Historical dashboard/leaderboard commission reads as $0 until a manager
  edits each order. Clean break; no backfill.
- Manager enters a **percentage 0–100** in the PO detail; stored as a
  fraction (`0.075`), clamped to `[0, 1]`. API JSON exposes the fraction
  (same shape as today's `commissionRate`, but now `number | null`).
- **Manager-only edit**, at any lifecycle stage. Purchasers see the rate and
  the resulting commission **read-only**.

## Approach

Clean removal + per-order rate (chosen Approach A): delete the tier model,
the `/api/commission` route, both commission tables, the Settings Commission
panel, and `users.commission_rate`. Add `orders.commission_rate`. No dead
schema or code left behind.

## Data model

Migration `0030_per_order_commission_rate.sql` (idempotent — the runner
re-applies every migration each run):

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,4);
-- nullable, NO default: NULL = manager has not set a rate = $0 commission

DROP TABLE IF EXISTS commission_tiers CASCADE;
DROP TABLE IF EXISTS commission_settings CASCADE;
ALTER TABLE users DROP COLUMN IF EXISTS commission_rate;
```

No backfill. Existing orders keep `commission_rate = NULL`.

## Backend

- **`GET /api/orders`**: select `o.commission_rate::float AS commission_rate`
  instead of `u.commission_rate`; remove it from `GROUP BY`. JSON
  `commissionRate` becomes `number | null`.
- **`PATCH /api/orders/:id`**: add `commissionRate` to the order-level
  update. Manager-only — a non-manager supplying it gets `403`. Accept a
  fraction (frontend converts % → fraction), clamp to `[0, 1]`; `null`
  explicitly unsets. Reuse the existing role/ownership checks in the route.
- **`dashboard.ts`**: delete the tier query and `computeCommission` import.
  Commission = per order `order.profit × COALESCE(order.commission_rate, 0)`,
  summed for the KPI scope and per purchaser for the leaderboard. (This makes
  the earlier per-line vs aggregate concern moot — the rate is per order.)
- **`me.ts`**: Profile lifetime — replace hardcoded `* 0.075` with a join to
  `orders` using `COALESCE(o.commission_rate, 0)`.
- **Delete**: `src/routes/commission.ts`, `src/lib/commission-calc.ts`, and
  the `/api/commission` mount in `src/index.ts`.
- **`scripts/seed.mjs`**: stop seeding `users.commission_rate`, tiers, and
  commission_settings. Seed a realistic `commission_rate` on a subset of
  orders (e.g. the non-draft ones) so the demo dashboard is not all-zero;
  drafts/unpriced orders stay `NULL`.

## Frontend

- **`DesktopEditOrder`**: add a "Commission rate (%)" field in the order
  detail. Editable only when `user.role === 'manager'`; read-only otherwise.
  Percent input 0–100, converted to a fraction on save through the existing
  `api.patch('/api/orders/:id', …)` call. Blank/— when `null`.
- **`DesktopOrders`**: `commissionFor` = `profit × (o.commissionRate ?? 0)`,
  no `0.05` fallback. The commission column shows `—`/`$0` for unset orders.
- **`DesktopSettings`**: remove the `'commission'` section, the
  `CommissionPanel` component, and its nav/section entry.
- **`lib/types.ts`**: `commissionRate: number | null`.
- **Profile / Dashboard**: no structural change; figures come from the
  updated APIs. Remove any client-side `0.075`/tier remnants.

## Tests

- Delete `tests/commission.test.ts`.
- Rewrite the dashboard commission invariant test: with a known per-order
  rate, assert `kpis.commission == Σ profit × rate` and that it equals the
  purchaser's leaderboard commission.
- Update `tests/orders.test.ts`: the `commissionRate === 0.075` expectation
  becomes the per-order value (or `null` for an unset order).
- Add: a manager can `PATCH` an order's `commissionRate`; a purchaser doing
  so gets `403`; an order with `NULL` rate contributes `$0` to the dashboard.
- Backend suite green; frontend + backend typecheck clean.

## Out of scope

- The order `payment` concept (Company / Self) stays — only the rate *rules*
  tied to payment type are removed.
- No commission audit log / rate-change history (YAGNI).
- No lifecycle lock on the rate (manager may edit at any stage).
