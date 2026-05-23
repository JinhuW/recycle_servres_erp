# Market: manual price entry + deprecate avg sell

Date: 2026-05-23
Status: Approved (brainstorm) — pending implementation plan

## Problem

The Market Value page presents `avg_sell` as the headline reference
price.  In practice the table can be sparse (one or two samples for many
SKUs), so an average is a misleading signal for the team setting buy
ceilings.  Two related gaps:

1. There is no manual way to record today's price into a SKU.  The only
   write path is the scraper at `POST /api/market/values` (bearer-only),
   which doesn't help when a manager gets a fresh broker quote by phone.
2. There is no freshness signal.  A row whose last data point is months
   old looks identical to one updated this morning.

## Goals

- Replace "avg sell price" as the page's headline metric with the most
  recent recorded price ("last price").
- Surface staleness: a row with no fresh data point in the last 5 days
  reads red and reports low/stale confidence.
- Let managers manually record a new price on any SKU directly from the
  Market page, with a per-entry audit trail.
- Keep the existing scraper write path working; manual and scraped
  entries are equal — most recent wins.

## Non-goals

- No "manual override locked" precedence flag.  A manual entry is just a
  data point; a later scraper push can supersede it (and vice-versa).
- No bulk-edit mode and no inline page-wide editing.  Single-row,
  popover-driven entry only.
- No new mobile UI in this slice.  Manual entry is desktop-only for now;
  the mobile Market view (if any) keeps the read-only display.
- `avg_sell` is not removed from the schema or the API.  Only the UI
  stops featuring it; MCP and other callers are unaffected.

## Approach (high level)

Add denormalised `last_price`, `last_price_at`, `last_price_source`
columns on `ref_prices`, plus a per-entry `ref_price_events` audit
table.  All writes (manual + scraper + seed) flow through a single
`appendPriceEvent` helper that inserts an event and updates the
denormalised columns within one `sql.begin` transaction.

This matches the audit pattern set yesterday with `sell_order_events`
(migration 0050) and keeps reads cheap (no JSONB digging), filterable
(stale-only filter), and sortable (`last_price_at` indexed).

## Data model

### Migration `0052_ref_prices_manual_overrides.sql`

```sql
ALTER TABLE ref_prices
  ADD COLUMN last_price        NUMERIC,
  ADD COLUMN last_price_at     TIMESTAMPTZ,
  ADD COLUMN last_price_source TEXT;  -- 'manual:<email>' | 'scraper:<name>' | 'seed'

CREATE INDEX ref_prices_last_price_at_idx
  ON ref_prices (last_price_at DESC);

CREATE TABLE ref_price_events (
  id            BIGSERIAL PRIMARY KEY,
  ref_price_id  UUID NOT NULL REFERENCES ref_prices(id) ON DELETE CASCADE,
  price         NUMERIC NOT NULL CHECK (price >= 0),
  source        TEXT    NOT NULL,
  note          TEXT,
  actor_user_id UUID    REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ref_price_events_ref_price_id_idx
  ON ref_price_events (ref_price_id, created_at DESC);
```

### Source label convention

| Origin       | `source` value             |
|--------------|----------------------------|
| Manual entry | `manual:<user.email>`      |
| Scraper push | `scraper:<v.source>`       |
| Seed         | `seed`                     |

### Existing fields

- `ref_prices.history` (JSONB) — no longer written.  Left in place for
  now; cleanup deferred to a follow-up.
- `ref_prices.avg_sell` — still written by the scraper path (kept for
  MCP/legacy consumers); UI ignores it.

## Backend

### Shared write helper — `apps/backend/src/lib/refPriceEvents.ts`

```ts
export async function appendPriceEvent(
  tx: postgres.TransactionSql,
  args: {
    refPriceId: string;
    price: number;
    source: string;
    note: string | null;
    actorUserId: string | null;
  },
) {
  const ev = (await tx`
    INSERT INTO ref_price_events
      (ref_price_id, price, source, note, actor_user_id)
    VALUES
      (${args.refPriceId}, ${args.price}, ${args.source},
       ${args.note}, ${args.actorUserId})
    RETURNING id, price::float AS price, source, note, created_at
  `)[0];
  await tx`
    UPDATE ref_prices
       SET last_price        = ${args.price},
           last_price_at     = ${ev.created_at},
           last_price_source = ${args.source},
           updated_at        = NOW()
     WHERE id = ${args.refPriceId}
  `;
  return ev;
}
```

Always called inside a caller-owned `sql.begin` block.

### Manual-entry endpoint — `POST /api/market/:id/manual-price`

- Cookie auth (`csrfGuard` already mounted on `/api/*`).
- Manager-only: `c.var.user.role !== 'manager' → 403` (matches the
  guard pattern in `routes/attachments.ts`, `routes/customers.ts`).
- Request: `{ price: number, note?: string }`
  - `price` finite, `>= 0`, `Number.isFinite`
  - `note` ≤ 280 chars
- Responses:
  - `200 { lastPrice, lastPriceAt }` on success
  - `400 { error: 'invalid_price' | 'note_too_long' }` on validation
  - `403 { error: 'Forbidden' }` for non-managers
  - `404 { error: 'not_found' }` if `:id` doesn't exist
- Writes within `sql.begin`: calls `appendPriceEvent` with
  `source = 'manual:' + user.email` and `actorUserId = user.id`.

### Scraper path refactor — `lib/marketWrite.ts`

- Existing validation kept (`low >= 0`, `low <= avg <= high`, samples
  integer).
- The per-row `UPDATE ref_prices SET low_price, high_price, avg_sell,
  samples, source, trend, history, updated_at` is kept, but the
  `history` column is no longer appended.  After the update, call
  `appendPriceEvent(tx, { refPriceId, price: avg, source: 'scraper:' +
  v.source, note: null, actorUserId: null })`.
- Metrics unchanged (`marketWritesTotal{outcome}`).

### Read query — `GET /api/market`

- Add `rp.last_price, rp.last_price_at, rp.last_price_source` to the
  `SELECT` list.
- LATERAL subquery for the sparkline:
  ```sql
  LEFT JOIN LATERAL (
    SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
             'ts',    e.created_at,
             'price', e.price
           ) ORDER BY e.created_at DESC) AS recent
    FROM (
      SELECT created_at, price FROM ref_price_events
      WHERE ref_price_id = rp.id
      ORDER BY created_at DESC LIMIT 12
    ) e
  ) rec ON TRUE
  ```
- `formatRefPrice` (in `lib/market.ts`) gains: `lastPrice`,
  `lastPriceAt` (ISO), `lastPriceSource`, `recentPrices: [{ts, price}]`
  (chronological, oldest first — reverse the SQL DESC list).
- `avg_sell` stays in the DTO.

### Seed — `apps/backend/scripts/seed.mjs`

- For each SKU: insert the existing 12 weekly synthetic prices into
  `ref_price_events` with `source = 'seed'`, `created_at` spread
  across the last 12 weeks ending at the row's `updated_at`.
- The newest event's `(price, created_at, 'seed')` is written to
  `ref_prices.last_price / last_price_at / last_price_source`.
- The legacy `history` JSONB column is no longer populated.

This means after `pnpm db:reset`, every SKU's `last_price_at` matches
its existing `updated_at` (1–21 days old per seed), so roughly
three-quarters of rows render red-stale immediately.  That is the
intended starting state — it tells the team which SKUs need a fresh
manual entry.

### Tests

All tests live in `apps/backend/tests/` and run against real Postgres.

**New file — `market-manual-price.test.ts`:**

- Manager POSTs valid price → 200 with `lastPrice`/`lastPriceAt`; a
  `ref_price_events` row exists with `source = 'manual:<email>'` and
  `actor_user_id = manager.id`; the `ref_prices` row's denorm columns
  match.
- Member (`role !== 'manager'`) POSTs → 403, no event row written.
- Manager POSTs with `price = -1` → 400 `invalid_price`.
- Manager POSTs with `note` of 281 chars → 400 `note_too_long`.
- Manager POSTs to nonexistent `:id` → 404, no event row written.
- Two sequential manager POSTs append two distinct events;
  `recentPrices` (via subsequent `GET /api/market`) reflects both in
  chronological order; `lastPrice` matches the second post.
- CSRF: POST without `X-Requested-By` → 403 (csrfGuard).

**Extend `market-write.test.ts`:**

- Scraper batch writes one `ref_price_events` row per accepted value
  with `source = 'scraper:<v.source>'` and `actor_user_id IS NULL`.
- `ref_prices.history` is unchanged (no append).
- `ref_prices.last_price*` reflects the latest scraper avg.

**Extend `market.test.ts`:**

- `GET /api/market` returns `lastPrice`, `lastPriceAt`,
  `lastPriceSource`, and `recentPrices: [{ts, price}]` (oldest first,
  ≤ 12 items).
- `avg_sell` is still present in the DTO.

## Frontend

Scope: `apps/frontend/src/pages/desktop/DesktopMarket.tsx` only.  The
mobile and vendor shells are untouched.

### Type changes — `apps/frontend/src/lib/types.ts`

```ts
export type RefPrice = {
  // … existing fields kept (avgSell, samples, source, trend, etc.) …
  lastPrice: number | null;
  lastPriceAt: string | null;       // ISO
  lastPriceSource: string | null;
  recentPrices: { ts: string; price: number }[]; // oldest first
};
```

### Derived helpers — `DesktopMarket.tsx` (top of file)

```ts
const STALE_DAYS = 5;

function staleness(r: RefPrice) {
  if (!r.lastPriceAt) return { days: null, isStale: true };
  const days = Math.floor((Date.now() - +new Date(r.lastPriceAt)) / 86_400_000);
  return { days, isStale: days > STALE_DAYS };
}
```

### Column changes

- "Avg sell price" → "Last sell price".  Cell shows
  `fmtUSD(r.lastPrice)` (or em-dash if null).  Subtext shows
  `relTime(r.lastPriceAt)` plus `· stale` if `isStale`.
- Stale cell styling: text `var(--neg)`; background
  `color-mix(in oklch, var(--neg) 8%, transparent)`; small
  `<Icon name="alertTriangle" size={11} />` to the left of the
  number with a `title="No update in the last N days"` attribute.
- Max-buy cell now derives `maxBuy = lastPrice × (1 - targetMargin)`
  instead of `avgSell × …`.  Null `lastPrice` → em-dash, no chip.

### Sparkline & detail panel

- Sparkline reads `r.recentPrices.map(p => p.price)`.  Remove the
  pre-existing `c * 1.35` markup pass.
- Dual-line chart in `DetailExpand` plots the same series for "Sell";
  the "Cost" series remains synthetic for now (out of scope).
- Confidence text: when `isStale`, render `Confidence: Stale` in
  `var(--neg)` regardless of `samples`.

### Manager-only inline edit

- `useAuth()` (from `lib/auth.tsx`) exposes `user.role`.  Render the
  pencil only when `user?.role === 'manager'`.  The endpoint is the
  source of truth for authorization; the affordance is a UX gate, not
  a security boundary.
- Hover the Last-price cell → small pencil button at right edge
  (`opacity: 0` baseline, `1` on row hover).  `aria-label="Update
  price"`.
- Click opens a popover (260px) anchored to the cell, rendered into a
  portal:
  - Header: SKU label + part number
  - Numeric input prefilled with `lastPrice ?? ''`, autofocus
  - One-line `note` input (placeholder "Optional note — broker, source")
  - Save (primary) / Cancel
- Save → `api.post('/api/market/' + r.id + '/manual-price', { price,
  note })`.  Optimistic update: set `r.lastPrice`, `r.lastPriceAt =
  now`, append to `r.recentPrices`.  On 4xx, revert + toast via
  `handleFetchError`.
- Keys: Esc → close (no save), `Cmd/Ctrl+Enter` → save.

### Filters

- Add "Show stale only" toggle in the card head next to the sort
  dropdown.  Pure client-side: filters `rows` to `isStale === true`.
  State persists per-session via `lib/preferences.tsx` (new key
  `marketShowStaleOnly`).

### i18n — `apps/frontend/src/lib/i18n.tsx`

- `marketLastPrice`, `marketStale`, `marketUpdatePrice`,
  `marketShowStaleOnly`, `marketPriceNotePlaceholder`,
  `marketNoUpdateRecently`.

### Frontend tests

Frontend tests are sparse by repo convention; add coverage only for
the derived `staleness()` helper (pure function) in a new
`apps/frontend/src/pages/desktop/DesktopMarket.test.ts`.  Boundary
cases: null `lastPriceAt`, exactly 5 days, 6 days.

## Authorization & CSRF

- Manual-entry endpoint is mounted under `/api/market` (already inside
  the cookie-auth + CSRF middleware chain).  The bearer-only scraper
  endpoint at `POST /api/market/values` stays as-is — it uses
  `bearerGuard({ scopes: ['market:write'] })`.
- Per-route check: `c.var.user.role !== 'manager' → 403`.  The
  frontend pencil affordance is hidden for non-managers but is not
  the enforcement boundary.

## Failure modes & edge cases

- **Empty `lastPrice` on existing rows after migration:** seed
  backfills it; for any row the seed misses, the UI shows em-dash and
  treats it as stale (red).
- **Concurrent manual + scraper writes on the same SKU:** both append
  events; whichever transaction commits last sets `last_price*`.  No
  precedence rule needed — that matches the agreed model.
- **Note injection / oversize:** length-capped server-side at 280;
  rendered as plain text (no HTML), so XSS surface is the existing
  React-escaped path.
- **Negative or NaN price:** rejected server-side with 400.
- **Stale check across timezones:** server emits ISO `lastPriceAt`;
  client compares to `Date.now()` — both UTC under the hood, no DST
  surprise.
- **Pencil shown to a manager who has been demoted mid-session:** the
  endpoint returns 403 and the client toasts the error; no partial
  update is committed.

## Rollout

- One PR.  Migration runs on backend boot via the existing ledger
  (`scripts/migrate.mjs`).  Then `pnpm db:reset` in dev to seed the
  new shape.
- No feature flag.  The page change is visible to every user the
  moment the PR ships; the inline pencil is visible only to managers.

## Open follow-ups (not in this slice)

- Drop the legacy `ref_prices.history` JSONB column once we are sure
  nothing reads it (separate migration).
- Real "Cost" series on the detail-panel chart (currently synthetic).
- Mobile Market manual-entry UI.
- Bulk update or CSV import.
