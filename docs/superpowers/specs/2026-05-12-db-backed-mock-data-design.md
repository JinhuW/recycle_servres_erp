# DB-backed mock data — design

**Date:** 2026-05-12
**Scope:** Move all remaining hardcoded mock data in the frontend to the database, exposed via the backend API.

## Context

Existing migrations have already moved a lot of this data DB-side:
- `0006_lookup_tables.sql` — catalog options, payment terms, price sources, sell-order statuses, workflow stages.
- `0007_disk_health_and_hdd.sql` — HDD category dropdowns, `health`/`rpm` line fields.
- `0008_user_preferences.sql` — per-user UI prefs JSONB.
- `0009_warehouse_details.sql` — `warehouses.address/manager/manager_phone/manager_email/timezone/cutoff_local/sqft` (already backfilled).

This spec lands on top of those as `0010_db_backed_mock_data.sql`. It covers what's still hardcoded in the frontend.

## Goals

1. The frontend bundle contains no row-shaped business data — only presentation (tone maps, icons, copy, breakpoints, build constants).
2. Settings panels that edit a dataset persist their edits via the API.
3. The seed script populates everything so a fresh DB matches the prior UX.
4. No backwards-compat shims for the deleted constants.

## Non-goals

- Real invitation email / token flow (revoke-via-status only).
- Auto-updating `last_seen_at` on auth (seeded once, manually editable).
- Computing customer outstanding-AR from `sell_orders` actuals.
- Real-time warehouse capacity calculation.
- New Settings UI controls beyond what's already wired.

## Data model

### New table — `categories`

Replaces `DEFAULT_CATEGORIES` in `DesktopSettings.tsx`. Also gives `DesktopMarket.tsx` per-category margins so the hardcoded `TARGET_MARGIN = 0.30` can go.

```sql
CREATE TABLE IF NOT EXISTS categories (
  id              TEXT PRIMARY KEY,         -- 'RAM','SSD','Other','CPU','GPU'
  label           TEXT NOT NULL,
  icon            TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  ai_capture      BOOLEAN NOT NULL DEFAULT FALSE,
  requires_pn     BOOLEAN NOT NULL DEFAULT TRUE,
  default_margin  NUMERIC(5,4) NOT NULL DEFAULT 0.30,    -- 0.30 = 30%
  position        INTEGER NOT NULL DEFAULT 0
);
```

`orders.category`, `order_lines.category`, `ref_prices.category` stay as `TEXT` — soft reference, no FK (existing rows use string values and we don't want to break them).

### New table — `invites`

Replaces `PENDING_INVITES` in `DesktopSettings.tsx`. Revoke flips status; resend stays a toast-only UI gesture; accept is out of scope (no token flow yet).

```sql
CREATE TABLE IF NOT EXISTS invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('manager','purchaser')),
  invited_by  UUID REFERENCES users(id),
  invited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','revoked','accepted'))
);
CREATE INDEX IF NOT EXISTS invites_status_idx ON invites(status);
```

### `warehouses` — no migration needed

The columns `address`, `manager`, `manager_phone`, `manager_email`, `timezone`, `cutoff_local`, `sqft` already exist on `warehouses` (via `0009_warehouse_details.sql`) and the backend route `routes/warehouses.ts` already returns + accepts them.

The frontend ignores them: `WAREHOUSE_EXTRAS` overrides the API values on reload. The fix is purely frontend — stop overriding.

Per design choice, the UI drops these displays/edits alongside the hardcoded extras:
- panel-header subtitle line "X sq ft total · Y% avg capacity"
- the receiving-cutoff row, floor-area row, capacity bar
- `active` / `receiving` toggles

Only address/manager/timezone are shown. The other columns stay in the DB unused (no destructive ALTERs).

### Extend — `users`

Replaces `pickLastSeen()` in `DesktopSettings.tsx`. Persistence-only — column exists so the UI can read/edit it; nothing auto-writes it yet.

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
```

`users.commission_rate` already exists (default 0.075) — we just surface it on `/api/orders` so the frontend can drop `COMMISSION_RATE = 0.05`.

### Extend — `customers`

Replaces `deriveCustomerSeed()` in `DesktopSettings.tsx`.

```sql
ALTER TABLE customers ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'Active'
  CHECK (status IN ('Active','Lead','On hold','Archived'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS outstanding_ar NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_order_at  TIMESTAMPTZ;
```

The existing `customers.active` boolean stays — `status='Archived'` implies `active=false` and vice versa, but the API will write both consistently.

## API changes

### `GET /api/lookups` (extended)

Append `categories` to the response shape:

```ts
type LookupsResponse = {
  catalog: Record<string, string[]>;
  paymentTerms: string[];
  priceSources: PriceSource[];
  sellOrderStatuses: SellOrderStatusInfo[];
  categories: CategoryRow[];   // NEW
};

type CategoryRow = {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
  aiCapture: boolean;
  requiresPN: boolean;
  defaultMargin: number;   // 0..1
  position: number;
};
```

### `routes/categories.ts` (new)

- `GET /api/categories` — list (also available via `/api/lookups`)
- `PATCH /api/categories/:id` — manager-only; accepts partial body
- `POST /api/categories` — manager-only; create new category

### `routes/invites.ts` (new)

- `GET /api/invites?status=pending` — list
- `POST /api/invites` — `{ email, role }`; manager-only
- `PATCH /api/invites/:id` — `{ status: 'revoked' }`; manager-only

### `routes/warehouses.ts` — no change

Already returns and accepts `address`, `manager`, `timezone`, etc. Frontend just needs to use them.

### `routes/members.ts` (extended)

- `GET /api/members` returns `last_seen_at`
- `PATCH /api/members/:id` accepts `last_seen_at` (manager-only — for ad-hoc edits in Settings)

### `routes/customers.ts` (extended)

- `GET` returns `status`, `outstanding_ar`, `last_order_at`
- `PATCH /api/customers/:id` accepts those fields

### `routes/orders.ts` (extended)

Each row in `GET /api/orders` gets a server-computed `commission = profit × users.commission_rate` (joined from `orders.user_id`). The frontend stops computing it.

## Frontend changes

### `lib/lookups.ts`

Add `categories: CategoryRow[]` (mutated in place by `loadLookups()`).

### `lib/catalog.ts`

Re-export `CATEGORIES = catalog.categories` (or similar — match the existing named-export convention).

### `DesktopSettings.tsx`

Delete: `DEFAULT_CATEGORIES`, `PENDING_INVITES`, `pickLastSeen`, `deriveCustomerSeed`, `WAREHOUSE_EXTRAS`, `WAREHOUSE_EXTRAS_DEFAULT`. Replace with API reads. Each Settings panel `PATCH`es on change with optimistic update + revert-on-error.

### `DesktopMarket.tsx`

Delete `TARGET_MARGIN`. Per-row max-buy: `avgSell × (1 − categories[p.category]?.defaultMargin ?? 0.30)` (the `?? 0.30` is a defensive fallback for legacy rows whose category isn't in the table).

### `DesktopOrders.tsx`

Delete `COMMISSION_RATE` and `commissionFor`. Read `order.commission` from the API response.

### `lib/types.ts`

Add `CategoryRow`, extend `Warehouse`, `Customer`, `Member`, `OrderSummary` types.

## Seed script changes

Insert:
- 6 `categories` rows (RAM/SSD/HDD/Other enabled; CPU/GPU disabled; margins 0.38/0.28/0.22/0.22/0.30/0.35 to mirror the current `DEFAULT_CATEGORIES` array which now includes HDD)
- 1 `invites` row (`noah.kim@recycleservers.io`, purchaser, invited_by alex)
- Warehouse details already backfilled by migration `0009`; no seed work needed
- For each non-manager user, set `last_seen_at = NOW() - random(0..3 days)` (deterministic via the existing PRNG)
- For each customer, set `status` (deterministic Active/Lead/On hold/Archived), `outstanding_ar`, `last_order_at` matching the prior `deriveCustomerSeed` distribution

Idempotent via `ON CONFLICT DO UPDATE` for the new tables, matching the existing seed style.

## Error handling

- Manager-only mutations: return 403 if `req.user.role !== 'manager'`. Existing routes already follow this pattern.
- API validation: minimal — Zod-style `parse` on request bodies for new fields, mirroring existing routes.
- Frontend: optimistic update with revert + toast on PATCH failure (matches existing pattern in DesktopSettings).

## Testing

- Run the existing `pnpm migrate && pnpm seed` end-to-end against a fresh DB.
- Manually exercise Settings panels (Categories, Members + Invites, Warehouses, Customers) — verify reload preserves edits.
- Verify Market page max-buy column still renders sensible numbers for all three categories.
- Verify Orders page commission column matches `profit × user.commission_rate` for a sample row.
- TypeScript build: `pnpm -w build` clean.

## Rollout

- Single PR; one migration, one seed update.
- No feature flag — the constants being replaced have no production users yet (mock data).
- Migration is additive (no column drops, no data deletes) — safe to apply against any existing dev DB.
