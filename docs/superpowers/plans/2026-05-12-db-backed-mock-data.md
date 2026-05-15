# DB-Backed Mock Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all remaining frontend-hardcoded mock data (categories, pending invites, last-seen, warehouse extras, customer derived fields, target margin, commission rate) into the database and serve them via the API.

**Architecture:** One additive migration `0010_db_backed_mock_data.sql` adds `categories` + `invites` tables and extends `users` / `customers` with new columns. Two new backend routes (`/api/categories`, `/api/invites`). `/api/lookups` returns categories; `/api/orders` adds server-computed `commission`; `/api/members` / `/api/customers` surface the new columns. The seed script seeds the new tables. The frontend deletes its seven hardcoded blocks and reads/writes through the API.

**Tech Stack:** Postgres, Hono on Cloudflare Workers, postgres-js, Vite + React + TypeScript, pnpm workspaces. No test framework configured for backend routes — verification is end-to-end via type-check, seed run, and manual UI exercise.

**Spec:** `docs/superpowers/specs/2026-05-12-db-backed-mock-data-design.md`

---

## File map

**Create:**
- `apps/backend/migrations/0010_db_backed_mock_data.sql` — new tables + columns
- `apps/backend/src/routes/categories.ts` — CRUD
- `apps/backend/src/routes/invites.ts` — list/create/revoke

**Modify:**
- `apps/backend/scripts/seed.mjs` — seed new tables + customer/users columns
- `apps/backend/src/index.ts` — mount the two new routes
- `apps/backend/src/routes/lookups.ts` — append `categories` to response
- `apps/backend/src/routes/orders.ts` — server-compute `commission` in list + detail
- `apps/backend/src/routes/members.ts` — read/write `last_seen_at`
- `apps/backend/src/routes/customers.ts` — read/write `status`, `outstanding_ar`, `last_order_at`
- `apps/frontend/src/lib/lookups.ts` — `categories` slot + load
- `apps/frontend/src/lib/catalog.ts` — re-export `CATEGORIES`
- `apps/frontend/src/lib/types.ts` — `CategoryRow`, extend `OrderSummary`, add Member/Customer
- `apps/frontend/src/pages/desktop/DesktopSettings.tsx` — kill `DEFAULT_CATEGORIES`, `PENDING_INVITES`, `pickLastSeen`, `deriveCustomerSeed`, `WAREHOUSE_EXTRAS*`
- `apps/frontend/src/pages/desktop/DesktopMarket.tsx` — kill `TARGET_MARGIN`
- `apps/frontend/src/pages/desktop/DesktopOrders.tsx` — kill `COMMISSION_RATE`

---

## Task 1: Migration 0010 — new tables and columns

**Files:**
- Create: `apps/backend/migrations/0010_db_backed_mock_data.sql`

- [ ] **Step 1: Write the migration**

Create `apps/backend/migrations/0010_db_backed_mock_data.sql` with:

```sql
-- Move remaining hardcoded frontend mock data into the DB:
--   • categories       — item categories (formerly DEFAULT_CATEGORIES in DesktopSettings)
--   • invites          — pending member invitations (formerly PENDING_INVITES)
--   • users.last_seen_at        — formerly pickLastSeen() deterministic mock
--   • customers.status/AR/last_order_at — formerly deriveCustomerSeed()
--
-- Warehouse extras and per-user commission rates already live in earlier
-- migrations (0009 and 0002 respectively); they're just plumbed through
-- the API in this change.

CREATE TABLE IF NOT EXISTS categories (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  icon            TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  ai_capture      BOOLEAN NOT NULL DEFAULT FALSE,
  requires_pn     BOOLEAN NOT NULL DEFAULT TRUE,
  default_margin  NUMERIC(5,4) NOT NULL DEFAULT 0.30,
  position        INTEGER NOT NULL DEFAULT 0
);

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

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'Active'
    CHECK (status IN ('Active','Lead','On hold','Archived')),
  ADD COLUMN IF NOT EXISTS outstanding_ar NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_order_at  TIMESTAMPTZ;
```

- [ ] **Step 2: Run the migration**

Run from repo root:
```bash
pnpm --filter @recycle-erp/backend migrate
```
Expected: prints `· 0010_db_backed_mock_data.sql` and exits 0. (If `DATABASE_URL` isn't set, the script tells you so — load it from `apps/backend/.dev.vars`.)

- [ ] **Step 3: Verify schema with psql**

```bash
psql "$DATABASE_URL" -c "\d categories" -c "\d invites" \
  -c "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='last_seen_at'" \
  -c "SELECT column_name FROM information_schema.columns WHERE table_name='customers' AND column_name IN ('status','outstanding_ar','last_order_at')"
```
Expected: tables `categories`/`invites` exist; `users.last_seen_at` and the three customer columns exist.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0010_db_backed_mock_data.sql
git commit -m "feat(db): migration 0010 — categories, invites, last_seen, customer status/AR/last_order"
```

---

## Task 2: Seed the new tables and columns

**Files:**
- Modify: `apps/backend/scripts/seed.mjs`

- [ ] **Step 1: Add CATEGORIES, PENDING_INVITES constants near the existing constant block**

In `apps/backend/scripts/seed.mjs`, locate the line `const CONDITIONS = ['New',...];` and insert after the existing constants:

```js
// ── Item categories (formerly DEFAULT_CATEGORIES in DesktopSettings) ────────
const CATEGORIES = [
  { id: 'RAM',   label: 'RAM',   icon: 'chip',  enabled: true,  ai_capture: true,  requires_pn: true,  default_margin: 0.38, position: 0 },
  { id: 'SSD',   label: 'SSD',   icon: 'drive', enabled: true,  ai_capture: false, requires_pn: true,  default_margin: 0.28, position: 1 },
  { id: 'HDD',   label: 'HDD',   icon: 'drive', enabled: true,  ai_capture: true,  requires_pn: true,  default_margin: 0.22, position: 2 },
  { id: 'Other', label: 'Other', icon: 'box',   enabled: true,  ai_capture: false, requires_pn: false, default_margin: 0.22, position: 3 },
  { id: 'CPU',   label: 'CPU',   icon: 'chip',  enabled: false, ai_capture: false, requires_pn: true,  default_margin: 0.30, position: 4 },
  { id: 'GPU',   label: 'GPU',   icon: 'chip',  enabled: false, ai_capture: false, requires_pn: true,  default_margin: 0.35, position: 5 },
];

// One stub pending invite so the Members panel renders the empty-state edge.
const INVITES = [
  { email: 'noah.kim@recycleservers.io', role: 'purchaser', invited_by_email: 'alex@recycleservers.io' },
];
```

- [ ] **Step 2: Insert categories + invites in the seed runner**

In `apps/backend/scripts/seed.mjs`, find the `console.log('· Seeding lookup tables…');` block. Immediately after the `SELL_ORDER_STATUSES` insert loop ends (just before `console.log('· Seeding ref_prices…');`), insert:

```js
  // Categories (used by Market max-buy, Submit form, Settings → Categories).
  await sql`DELETE FROM categories`;
  for (const c of CATEGORIES) {
    await sql`
      INSERT INTO categories (id, label, icon, enabled, ai_capture, requires_pn, default_margin, position)
      VALUES (${c.id}, ${c.label}, ${c.icon}, ${c.enabled}, ${c.ai_capture}, ${c.requires_pn}, ${c.default_margin}, ${c.position})
    `;
  }

  // Pending invites (Settings → Members shows these as the second list).
  await sql`DELETE FROM invites`;
  for (const i of INVITES) {
    await sql`
      INSERT INTO invites (email, role, invited_by, status)
      VALUES (${i.email}, ${i.role}, ${emailToUuid[i.invited_by_email] ?? null}, 'pending')
    `;
  }
```

- [ ] **Step 3: Backfill users.last_seen_at and customers.status/AR/last_order_at**

In `apps/backend/scripts/seed.mjs`, find the customer seeding block. Replace the `for (const c of customers)` insert loop with:

```js
  // Deterministic mock for status/AR/last-order so the Settings → Customers
  // panel renders something other than identical "Active / $0 / —" rows.
  const STATUS_POOL = ['Active','Active','Active','Lead','On hold'];
  const customerRows = [];
  for (let idx = 0; idx < customers.length; idx++) {
    const c = customers[idx];
    const r1 = rand(), r2 = rand(), r3 = rand();
    const status         = STATUS_POOL[Math.floor(r1 * STATUS_POOL.length)];
    const outstanding_ar = r2 > 0.55 ? Math.round(r2 * 18000 * 100) / 100 : 0;
    const last_order_at  = new Date(Date.now() - Math.round(1 + r3 * 60) * 86400000);
    const r = await sql`
      INSERT INTO customers (name, short_name, contact, region, terms, credit_limit, tags, status, outstanding_ar, last_order_at)
      VALUES (${c.name}, ${c.short}, ${c.contact}, ${c.region}, ${c.terms}, ${c.creditLimit}, ${c.tags},
              ${status}, ${outstanding_ar}, ${last_order_at})
      RETURNING id
    `;
    customerRows.push({ ...c, id: r[0].id });
  }
```

Then find the `console.log('· Seeding users…');` block. Inside the `for (const u of USERS)` loop, change the upsert to set `last_seen_at`:

Replace:
```js
    await sql`
      INSERT INTO users (email, name, initials, role, team, password_hash)
      VALUES (${u.email}, ${u.name}, ${u.initials}, ${u.role}, ${u.team}, ${passwordHash})
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name, initials = EXCLUDED.initials,
        role = EXCLUDED.role, team = EXCLUDED.team
    `;
```

With:
```js
    // Deterministic mock last-seen so Settings → Members shows a varied list.
    const lastSeen = u.role === 'manager'
      ? new Date()
      : new Date(Date.now() - Math.round(rand() * 3 * 86400000));
    await sql`
      INSERT INTO users (email, name, initials, role, team, password_hash, last_seen_at)
      VALUES (${u.email}, ${u.name}, ${u.initials}, ${u.role}, ${u.team}, ${passwordHash}, ${lastSeen})
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name, initials = EXCLUDED.initials,
        role = EXCLUDED.role, team = EXCLUDED.team,
        last_seen_at = EXCLUDED.last_seen_at
    `;
```

- [ ] **Step 4: Run seed and verify**

```bash
pnpm --filter @recycle-erp/backend seed
```
Expected: prints all the existing seed lines plus the categories/invites inserts, exits 0.

Then:
```bash
psql "$DATABASE_URL" -c "SELECT id, default_margin FROM categories ORDER BY position"
psql "$DATABASE_URL" -c "SELECT email, role, status FROM invites"
psql "$DATABASE_URL" -c "SELECT email, last_seen_at FROM users ORDER BY role, email LIMIT 6"
psql "$DATABASE_URL" -c "SELECT name, status, outstanding_ar, last_order_at FROM customers"
```
Expected: 6 categories, 1 invite, 6 users with last_seen, 6 customers with varied status/AR.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/scripts/seed.mjs
git commit -m "feat(seed): seed categories, invites, last_seen, customer status/AR"
```

---

## Task 3: New backend route — `/api/categories`

**Files:**
- Create: `apps/backend/src/routes/categories.ts`

- [ ] **Step 1: Write the route**

Create `apps/backend/src/routes/categories.ts`:

```ts
import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const categories = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type Row = Record<string, unknown>;
const toApi = (r: Row) => ({
  id:            r.id as string,
  label:         r.label as string,
  icon:          r.icon as string,
  enabled:       r.enabled as boolean,
  aiCapture:     r.ai_capture as boolean,
  requiresPN:    r.requires_pn as boolean,
  defaultMargin: Number(r.default_margin),
  position:      r.position as number,
});

categories.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT * FROM categories ORDER BY position, id`;
  return c.json({ items: rows.map((r) => toApi(r as Row)) });
});

categories.post('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { id: string; label: string; icon?: string; enabled?: boolean; aiCapture?: boolean; requiresPN?: boolean; defaultMargin?: number; position?: number }
    | null;
  if (!body?.id || !body?.label) return c.json({ error: 'id and label are required' }, 400);

  const sql = getDb(c.env);
  try {
    const r = await sql`
      INSERT INTO categories (id, label, icon, enabled, ai_capture, requires_pn, default_margin, position)
      VALUES (
        ${body.id}, ${body.label}, ${body.icon ?? 'box'},
        ${body.enabled ?? true}, ${body.aiCapture ?? false},
        ${body.requiresPN ?? true}, ${body.defaultMargin ?? 0.30},
        ${body.position ?? 99}
      )
      RETURNING *
    `;
    return c.json(toApi(r[0] as Row), 201);
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? '';
    if (/duplicate|unique/i.test(msg)) return c.json({ error: `Category "${body.id}" already exists` }, 409);
    throw e;
  }
});

categories.patch('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const sql = getDb(c.env);
  const r = await sql`
    UPDATE categories SET
      label          = COALESCE(${(body.label as string) ?? null}, label),
      icon           = COALESCE(${(body.icon as string) ?? null}, icon),
      enabled        = COALESCE(${(body.enabled as boolean) ?? null}, enabled),
      ai_capture     = COALESCE(${(body.aiCapture as boolean) ?? null}, ai_capture),
      requires_pn    = COALESCE(${(body.requiresPN as boolean) ?? null}, requires_pn),
      default_margin = COALESCE(${(body.defaultMargin as number) ?? null}, default_margin),
      position       = COALESCE(${(body.position as number) ?? null}, position)
    WHERE id = ${id}
    RETURNING *
  `;
  if (r.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json(toApi(r[0] as Row));
});

export default categories;
```

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/routes/categories.ts
git commit -m "feat(backend): /api/categories CRUD"
```

---

## Task 4: New backend route — `/api/invites`

**Files:**
- Create: `apps/backend/src/routes/invites.ts`

- [ ] **Step 1: Write the route**

Create `apps/backend/src/routes/invites.ts`:

```ts
import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const invites = new Hono<{ Bindings: Env; Variables: { user: User } }>();

invites.use('*', async (c, next) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  await next();
});

type Row = Record<string, unknown>;
const toApi = (r: Row) => ({
  id:         r.id as string,
  email:      r.email as string,
  role:       r.role as 'manager' | 'purchaser',
  invitedBy:  r.invited_by_name as string | null,
  invitedAt:  r.invited_at as string,
  status:     r.status as 'pending' | 'revoked' | 'accepted',
});

invites.get('/', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status') ?? 'pending';
  const rows = await sql`
    SELECT i.id, i.email, i.role, i.invited_at, i.status, u.name AS invited_by_name
    FROM invites i
    LEFT JOIN users u ON u.id = i.invited_by
    WHERE (${status} = 'all' OR i.status = ${status})
    ORDER BY i.invited_at DESC
  `;
  return c.json({ items: rows.map((r) => toApi(r as Row)) });
});

invites.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { email: string; role: 'manager' | 'purchaser' }
    | null;
  if (!body?.email || !body?.role) return c.json({ error: 'email and role required' }, 400);
  if (body.role !== 'manager' && body.role !== 'purchaser') {
    return c.json({ error: 'role must be manager or purchaser' }, 400);
  }

  const sql = getDb(c.env);
  try {
    const r = await sql`
      INSERT INTO invites (email, role, invited_by, status)
      VALUES (${body.email.toLowerCase()}, ${body.role}, ${c.var.user.id}, 'pending')
      RETURNING id, email, role, invited_at, status
    `;
    return c.json(toApi({ ...r[0], invited_by_name: c.var.user.name } as Row), 201);
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? '';
    if (/duplicate|unique/i.test(msg)) return c.json({ error: `${body.email} already invited` }, 409);
    throw e;
  }
});

invites.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { status?: 'revoked' } | null;
  if (!body?.status) return c.json({ error: 'status required' }, 400);
  if (body.status !== 'revoked') return c.json({ error: "status can only be set to 'revoked' from this endpoint" }, 400);

  const sql = getDb(c.env);
  const r = await sql`UPDATE invites SET status = 'revoked' WHERE id = ${id} RETURNING id`;
  if (r.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

export default invites;
```

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/routes/invites.ts
git commit -m "feat(backend): /api/invites list/create/revoke"
```

---

## Task 5: Mount the two new routes

**Files:**
- Modify: `apps/backend/src/index.ts`

- [ ] **Step 1: Add imports**

In `apps/backend/src/index.ts`, immediately after `import lookupsRoutes from './routes/lookups';`, add:

```ts
import categoriesRoutes from './routes/categories';
import invitesRoutes from './routes/invites';
```

- [ ] **Step 2: Add the authed middleware lines**

Below `app.use('/api/lookups/*', authMiddleware);`, add:

```ts
app.use('/api/categories/*', authMiddleware);
app.use('/api/invites/*', authMiddleware);
```

- [ ] **Step 3: Add the route mounts**

Below `app.route('/api/lookups', lookupsRoutes);`, add:

```ts
app.route('/api/categories', categoriesRoutes);
app.route('/api/invites', invitesRoutes);
```

- [ ] **Step 4: Smoke test the API**

Restart the dev server, then (with a manager token in `recycle_erp_token` localStorage):

```bash
curl -s http://localhost:8787/api/categories -H "Authorization: Bearer $TOKEN" | head
curl -s "http://localhost:8787/api/invites?status=pending" -H "Authorization: Bearer $TOKEN" | head
```
Expected: each returns `{ "items": [ ... ] }` with the seeded rows.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/index.ts
git commit -m "feat(backend): mount /api/categories and /api/invites"
```

---

## Task 6: Extend `/api/lookups` with categories

**Files:**
- Modify: `apps/backend/src/routes/lookups.ts`

- [ ] **Step 1: Add the categories query and append it to the response**

Replace the body of `lookups.get('/', …)` in `apps/backend/src/routes/lookups.ts` so the destructure includes a 5th query and the JSON response includes a `categories` field:

```ts
lookups.get('/', async (c) => {
  const sql = getDb(c.env);

  const [catalogRows, termsRows, sourceRows, statusRows, categoryRows] = await Promise.all([
    sql`
      SELECT "group", value
      FROM catalog_options
      WHERE active = TRUE
      ORDER BY "group", position, value
    `,
    sql`
      SELECT label
      FROM payment_terms
      WHERE active = TRUE
      ORDER BY position, label
    `,
    sql`
      SELECT id, label
      FROM price_sources
      WHERE active = TRUE
      ORDER BY position, label
    `,
    sql`
      SELECT id, label, short_label, tone, needs_meta, position
      FROM sell_order_statuses
      ORDER BY position
    `,
    sql`
      SELECT id, label, icon, enabled, ai_capture, requires_pn,
             default_margin::float AS default_margin, position
      FROM categories
      ORDER BY position, id
    `,
  ]);

  const catalog: Record<string, string[]> = {};
  for (const row of catalogRows) {
    (catalog[row.group as string] ??= []).push(row.value as string);
  }

  return c.json({
    catalog,
    paymentTerms: termsRows.map(r => r.label as string),
    priceSources: sourceRows.map(r => ({ id: r.id as string, label: r.label as string })),
    sellOrderStatuses: statusRows.map(r => ({
      id: r.id as string,
      label: r.label as string,
      short: r.short_label as string,
      tone: r.tone as string,
      needsMeta: r.needs_meta as boolean,
      position: r.position as number,
    })),
    categories: categoryRows.map(r => ({
      id: r.id as string,
      label: r.label as string,
      icon: r.icon as string,
      enabled: r.enabled as boolean,
      aiCapture: r.ai_capture as boolean,
      requiresPN: r.requires_pn as boolean,
      defaultMargin: r.default_margin as number,
      position: r.position as number,
    })),
  });
});
```

- [ ] **Step 2: Verify**

```bash
curl -s http://localhost:8787/api/lookups -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; d=json.load(sys.stdin); print('categories:', len(d['categories']))"
```
Expected: `categories: 6`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/routes/lookups.ts
git commit -m "feat(backend): include categories in /api/lookups"
```

---

## Task 7: Server-compute `commission` in `/api/orders`

**Files:**
- Modify: `apps/backend/src/routes/orders.ts`

- [ ] **Step 1: Join commission_rate in the list query and include `commission` in the response**

In `apps/backend/src/routes/orders.ts`, inside `orders.get('/', …)`:

Replace the SELECT/FROM block (the big multi-line query starting at `const rows = await sql\`SELECT…`) with:

```ts
  const rows = await sql`
    SELECT
      o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
      o.total_cost::float AS total_cost,
      u.name AS user_name, u.initials AS user_initials,
      u.commission_rate::float AS commission_rate,
      w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region,
      COALESCE(SUM(l.qty), 0)::int                                                  AS qty,
      COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float         AS revenue,
      COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit,
      COUNT(l.id)::int                                                              AS line_count,
      array_agg(DISTINCT l.status)                                                  AS line_statuses
    FROM orders o
    JOIN users u      ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    LEFT JOIN order_lines l ON l.order_id = o.id
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag}
    GROUP BY o.id, u.name, u.initials, u.commission_rate, w.id, w.short, w.region
    ORDER BY o.created_at DESC
    LIMIT ${limit}
  `;
```

Then update the `return c.json({ orders: rows.map(r => ({ ... })) });` mapping to add `commission`:

```ts
  return c.json({
    orders: rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userInitials: r.user_initials,
      category: r.category,
      payment: r.payment,
      notes: r.notes,
      lifecycle: r.lifecycle,
      createdAt: r.created_at,
      totalCost: r.total_cost,
      warehouse: r.warehouse_id ? { id: r.warehouse_id, short: r.warehouse_short, region: r.warehouse_region } : null,
      qty: r.qty,
      revenue: r.revenue,
      profit: r.profit,
      commission: +((Number(r.profit) || 0) * (Number(r.commission_rate) || 0)).toFixed(2),
      lineCount: r.line_count,
      status: (r.line_statuses?.length === 1 ? r.line_statuses[0] : 'Mixed') as string,
    })),
  });
```

- [ ] **Step 2: Mirror the change in `/api/orders/:id`**

In the same file, inside `orders.get('/:id', …)`:

Replace the `const order = (await sql\`SELECT o.id…\`)[0];` block with:

```ts
  const order = (await sql`
    SELECT o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
           o.total_cost::float AS total_cost,
           u.name AS user_name, u.initials AS user_initials,
           u.commission_rate::float AS commission_rate,
           w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE o.id = ${id}
    LIMIT 1
  `)[0];
```

Then in the `return c.json({ order: { … } });` mapping, compute profit and add commission. Replace the existing `return c.json({ order: { ... } })` block with:

```ts
  const profit = lines.reduce(
    (s, l) => s + (((l.sell_price ?? l.unit_cost) - l.unit_cost) * (l.qty as number)),
    0,
  );

  return c.json({
    order: {
      id: order.id,
      userId: order.user_id,
      userName: order.user_name,
      userInitials: order.user_initials,
      category: order.category,
      payment: order.payment,
      notes: order.notes,
      lifecycle: order.lifecycle,
      status,
      createdAt: order.created_at,
      totalCost: order.total_cost,
      commission: +(profit * (Number(order.commission_rate) || 0)).toFixed(2),
      warehouse: order.warehouse_id
        ? { id: order.warehouse_id, short: order.warehouse_short, region: order.warehouse_region }
        : null,
      lines: lines.map(l => ({
        id: l.id,
        category: l.category,
        brand: l.brand,
        capacity: l.capacity,
        type: l.type,
        classification: l.classification,
        rank: l.rank,
        speed: l.speed,
        interface: l.interface,
        formFactor: l.form_factor,
        description: l.description,
        partNumber: l.part_number,
        condition: l.condition,
        qty: l.qty,
        unitCost: l.unit_cost,
        sellPrice: l.sell_price,
        status: l.status,
        scanImageId: l.scan_image_id,
        scanConfidence: l.scan_confidence,
        position: l.position,
        health: l.health,
        rpm: l.rpm,
      })),
    },
  });
```

- [ ] **Step 3: Verify**

```bash
curl -s "http://localhost:8787/api/orders?limit=3" -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; d=json.load(sys.stdin); print([(o['id'], o['profit'], o['commission']) for o in d['orders'][:3]])"
```
Expected: each tuple shows `commission ≈ profit × 0.075` (the default `users.commission_rate`).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/orders.ts
git commit -m "feat(backend): server-compute commission on /api/orders"
```

---

## Task 8: Extend `/api/members` with `last_seen_at`

**Files:**
- Modify: `apps/backend/src/routes/members.ts`

- [ ] **Step 1: Add `last_seen_at` to GET**

In `apps/backend/src/routes/members.ts`, update the `members.get('/', …)` query. Replace the existing select-list inside that handler with:

```ts
  const rows = await sql`
    SELECT u.id, u.email, u.name, u.initials, u.role, u.team, u.phone, u.title,
           u.active, u.commission_rate::float AS commission_rate, u.created_at,
           u.last_seen_at,
           COUNT(DISTINCT o.id)::int AS order_count,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS lifetime_profit
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    LEFT JOIN order_lines l ON l.order_id = o.id
    GROUP BY u.id
    ORDER BY u.role DESC, u.name
  `;
```

(Only the `u.last_seen_at,` line is added.)

- [ ] **Step 2: Accept `lastSeenAt` on PATCH**

In the same file, update the PATCH handler. Change the `body` type cast to add `lastSeenAt`:

```ts
    | { name?: string; team?: string; phone?: string; title?: string; role?: string; commissionRate?: number; active?: boolean; password?: string; lastSeenAt?: string | null }
```

And add the column to the UPDATE statement (insert one new line into the SET clause):

```ts
  await sql`
    UPDATE users SET
      name            = COALESCE(${body.name ?? null}, name),
      team            = COALESCE(${body.team ?? null}, team),
      phone           = COALESCE(${body.phone ?? null}, phone),
      title           = COALESCE(${body.title ?? null}, title),
      role            = COALESCE(${body.role ?? null}, role),
      commission_rate = COALESCE(${body.commissionRate ?? null}, commission_rate),
      active          = COALESCE(${body.active ?? null}, active),
      last_seen_at    = COALESCE(${body.lastSeenAt ?? null}, last_seen_at)
    WHERE id = ${id}
  `;
```

- [ ] **Step 3: Verify**

```bash
curl -s http://localhost:8787/api/members -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; d=json.load(sys.stdin); print([(m['email'], m['last_seen_at']) for m in d['items'][:3]])"
```
Expected: each tuple shows a real timestamp for last_seen_at.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/members.ts
git commit -m "feat(backend): expose last_seen_at on /api/members"
```

---

## Task 9: Extend `/api/customers` with status/AR/last-order

**Files:**
- Modify: `apps/backend/src/routes/customers.ts`

- [ ] **Step 1: Update GET to return the new columns**

In `apps/backend/src/routes/customers.ts`, replace the `customers.get('/', …)` handler with:

```ts
customers.get('/', async (c) => {
  const sql = getDb(c.env);
  const search = c.req.query('q')?.toLowerCase().trim();
  const status = c.req.query('status') ?? 'all';
  const rows = await sql`
    SELECT c.id, c.name, c.short_name, c.contact, c.region, c.terms,
           c.credit_limit::float AS credit_limit, c.tags, c.notes, c.active,
           c.created_at,
           c.status         AS lifecycle_status,
           c.outstanding_ar::float AS outstanding_ar,
           c.last_order_at,
           COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS lifetime_revenue,
           COUNT(DISTINCT so.id)::int AS order_count,
           MAX(so.created_at)         AS last_order
    FROM customers c
    LEFT JOIN sell_orders so       ON so.customer_id = c.id
    LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
    WHERE (
      ${search ?? null}::text IS NULL
      OR LOWER(c.name) LIKE '%' || ${search ?? ''} || '%'
      OR LOWER(COALESCE(c.short_name,'')) LIKE '%' || ${search ?? ''} || '%'
    )
    AND ( ${status} = 'all' OR (${status} = 'active' AND c.active) OR (${status} = 'inactive' AND NOT c.active) )
    GROUP BY c.id
    ORDER BY c.name
  `;
  return c.json({ items: rows });
});
```

The new columns are named `lifecycle_status`, `outstanding_ar`, `last_order_at` to avoid clashing with the existing `status` query parameter and the SQL aggregate `last_order`.

- [ ] **Step 2: Accept the new fields on PATCH**

Replace the PATCH handler with:

```ts
customers.patch('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const lifecycle = body.lifecycleStatus as string | undefined;
  if (lifecycle !== undefined && !['Active','Lead','On hold','Archived'].includes(lifecycle)) {
    return c.json({ error: "lifecycleStatus must be 'Active' | 'Lead' | 'On hold' | 'Archived'" }, 400);
  }

  const sql = getDb(c.env);
  await sql`
    UPDATE customers SET
      name           = COALESCE(${(body.name as string) ?? null}, name),
      short_name     = COALESCE(${(body.shortName as string) ?? null}, short_name),
      contact        = COALESCE(${(body.contact as string) ?? null}, contact),
      region         = COALESCE(${(body.region as string) ?? null}, region),
      terms          = COALESCE(${(body.terms as string) ?? null}, terms),
      credit_limit   = COALESCE(${(body.creditLimit as number) ?? null}, credit_limit),
      tags           = COALESCE(${(body.tags as string[]) ?? null}, tags),
      notes          = COALESCE(${(body.notes as string) ?? null}, notes),
      active         = COALESCE(${(body.active as boolean) ?? null}, active),
      status         = COALESCE(${lifecycle ?? null}, status),
      outstanding_ar = COALESCE(${(body.outstandingAr as number) ?? null}, outstanding_ar),
      last_order_at  = COALESCE(${(body.lastOrderAt as string) ?? null}, last_order_at)
    WHERE id = ${id}
  `;
  return c.json({ ok: true });
});
```

- [ ] **Step 3: Verify**

```bash
curl -s http://localhost:8787/api/customers -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; d=json.load(sys.stdin); print([(c['name'], c.get('lifecycle_status'), c.get('outstanding_ar')) for c in d['items']])"
```
Expected: each tuple shows the status (Active/Lead/On hold) and AR amount from the seed.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/customers.ts
git commit -m "feat(backend): expose lifecycle status/AR/last-order on /api/customers"
```

---

## Task 10: Frontend lookups — load categories

**Files:**
- Modify: `apps/frontend/src/lib/lookups.ts`

- [ ] **Step 1: Add the category type and slot**

In `apps/frontend/src/lib/lookups.ts`, just above `type LookupsResponse`, add:

```ts
export type CategoryRow = {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
  aiCapture: boolean;
  requiresPN: boolean;
  defaultMargin: number;   // 0..1
  position: number;
};
export const categories: CategoryRow[] = [];
```

- [ ] **Step 2: Add `categories` to the response type**

Update `type LookupsResponse` to include the new field:

```ts
type LookupsResponse = {
  catalog: Record<string, string[]>;
  paymentTerms: string[];
  priceSources: PriceSource[];
  sellOrderStatuses: SellOrderStatusInfo[];
  categories: CategoryRow[];
};
```

- [ ] **Step 3: Mutate categories in the loader**

Inside the IIFE in `loadLookups()`, after the existing `sellOrderStatuses.splice(...)` line and before `orderStatuses.splice(...)`, add:

```ts
      categories.splice(0, categories.length, ...data.categories);
```

- [ ] **Step 4: TypeScript check**

```bash
pnpm --filter @recycle-erp/frontend exec tsc --noEmit
```
Expected: passes (no new errors).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/lookups.ts
git commit -m "feat(frontend): load categories from /api/lookups"
```

---

## Task 11: Frontend types and catalog re-export

**Files:**
- Modify: `apps/frontend/src/lib/catalog.ts`
- Modify: `apps/frontend/src/lib/types.ts`

- [ ] **Step 1: Re-export CATEGORIES from catalog.ts**

In `apps/frontend/src/lib/catalog.ts`, add at the end:

```ts
import { categories } from './lookups';
export const CATEGORIES = categories;
```

- [ ] **Step 2: Add `commission` to `OrderSummary`**

In `apps/frontend/src/lib/types.ts`, inside the `OrderSummary` type definition, add a line after `profit: number;`:

```ts
  commission: number;
```

(So the full type now has `profit`, `commission`, `lineCount`, `status`.)

- [ ] **Step 3: Add `commission` to `Order` indirectly**

`Order` is `OrderSummary & { lines: OrderLine[] }`, so it inherits `commission` automatically — no change needed.

- [ ] **Step 4: TypeScript check**

```bash
pnpm --filter @recycle-erp/frontend exec tsc --noEmit
```
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/catalog.ts apps/frontend/src/lib/types.ts
git commit -m "feat(frontend): export CATEGORIES + add commission to OrderSummary"
```

---

## Task 12: Replace DEFAULT_CATEGORIES with API in DesktopSettings

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

- [ ] **Step 1: Delete the hardcoded array**

In `apps/frontend/src/pages/desktop/DesktopSettings.tsx`, find the block starting with the comment `// ─── Categories ───` (around line 193) and delete the comment block, the `CategoryRow` type, and the `DEFAULT_CATEGORIES` constant — i.e. delete lines roughly 193–213. The next thing in the file should be `function CategoriesPanel() {`.

- [ ] **Step 2: Re-declare the local type from the API shape**

Just above `function CategoriesPanel() {`, insert:

```ts
import type { CategoryRow as ApiCategory } from '../../lib/lookups';
type CategoryRow = ApiCategory & { icon: IconName };  // narrow icon string→IconName for <Icon />
```

(The import goes at the top of the file alongside the other imports. Move only the `import type` line up — don't leave it mid-file.)

- [ ] **Step 3: Replace CategoriesPanel body to load from API and PATCH on change**

Replace the entire `function CategoriesPanel() { ... }` body (the function from `function CategoriesPanel() {` down to its closing `}`) with:

```ts
function CategoriesPanel() {
  const [cats, setCats] = useState<CategoryRow[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    api.get<{ items: CategoryRow[] }>('/api/categories')
      .then(r => setCats(r.items.map(c => ({ ...c, icon: c.icon as IconName }))))
      .catch(console.error)
      .finally(() => setLoadedOnce(true));
  }, []);

  const upd = (id: string, patch: Partial<CategoryRow>) => {
    setCats(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
    api.patch(`/api/categories/${id}`, patch).catch(err => {
      console.error(err);
      // Revert by re-fetching on failure.
      api.get<{ items: CategoryRow[] }>('/api/categories')
        .then(r => setCats(r.items.map(c => ({ ...c, icon: c.icon as IconName }))))
        .catch(() => { /* nothing else to do */ });
    });
  };

  return (
    <>
      <SettingsHeader
        title="Categories & SKUs"
        sub="Item categories your team submits and sells. Toggle to make available in submissions."
        actions={<button className="btn"><Icon name="plus" size={14} /> Add category</button>}
      />

      {!loadedOnce && <TableSkeleton rows={4} />}

      <div className="cat-list">
        {cats.map(c => (
          <div key={c.id} className={'cat-row card' + (c.enabled ? '' : ' disabled')}>
            <div className="cat-row-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="cat-icon"><Icon name={c.icon} size={18} /></div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{c.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {c.enabled ? 'Available in submissions' : 'Hidden — not selectable'}
                  </div>
                </div>
              </div>
              <Toggle checked={c.enabled} onChange={(v) => upd(c.id, { enabled: v })} />
            </div>

            <div className="cat-row-body">
              <div className="cat-opt">
                <div>
                  <div className="cat-opt-label">AI label capture</div>
                  <div className="cat-opt-sub">Photograph the part — vision model reads brand, capacity, speed.</div>
                </div>
                <Toggle checked={c.aiCapture} onChange={(v) => upd(c.id, { aiCapture: v })} disabled={!c.enabled} />
              </div>
              <div className="cat-opt">
                <div>
                  <div className="cat-opt-label">Require part number</div>
                  <div className="cat-opt-sub">Block submission until manufacturer PN is entered.</div>
                </div>
                <Toggle checked={c.requiresPN} onChange={(v) => upd(c.id, { requiresPN: v })} disabled={!c.enabled} />
              </div>
              <div className="cat-opt">
                <div>
                  <div className="cat-opt-label">Default margin target</div>
                  <div className="cat-opt-sub">Applied as commission baseline when no override is set.</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    value={Math.round(c.defaultMargin * 100)}
                    onChange={(e) => upd(c.id, { defaultMargin: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })}
                    disabled={!c.enabled}
                    style={{
                      width: 60, padding: '5px 8px', borderRadius: 6,
                      border: '1px solid var(--border)', background: 'var(--bg-elev)',
                      fontSize: 13, fontVariantNumeric: 'tabular-nums', textAlign: 'right',
                    }}
                  />
                  <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>%</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
```

(Note: the DB stores `default_margin` as a fraction 0..1, so the input divides by 100 on change and multiplies by 100 on display, unlike the prior `defaultMargin: 38` whole-number convention.)

- [ ] **Step 4: TypeScript check + manual exercise**

```bash
pnpm --filter @recycle-erp/frontend exec tsc --noEmit
```
Then in the browser at `localhost:5173/settings/categories`, toggle a category's enabled flag, refresh — confirm it persists.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "refactor(settings): load categories from /api/categories"
```

---

## Task 13: Replace PENDING_INVITES with API in DesktopSettings

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

- [ ] **Step 1: Replace the mock invite block**

In `apps/frontend/src/pages/desktop/DesktopSettings.tsx`, locate the block starting with `// Mock pending invites —` (around line 421). Delete those comment lines, the `PendingInvite` type, and the `PENDING_INVITES` constant. Replace with:

```ts
type PendingInvite = {
  id: string;
  email: string;
  role: 'manager' | 'purchaser';
  invitedBy: string | null;
  invitedAt: string;
  status: 'pending' | 'revoked' | 'accepted';
};
```

- [ ] **Step 2: Update MembersPanel to load invites from API**

In the same file, in `MembersPanel`, replace:

```ts
  const [pending, setPending] = useState<PendingInvite[]>(PENDING_INVITES);
```

With:

```ts
  const [pending, setPending] = useState<PendingInvite[]>([]);

  const reloadInvites = () => api.get<{ items: PendingInvite[] }>('/api/invites?status=pending')
    .then(r => setPending(r.items))
    .catch(console.error);
  useEffect(() => { reloadInvites(); }, []);
```

- [ ] **Step 3: Wire revoke to the API**

Find anywhere in `MembersPanel` (or its child invite renderer) where invites are removed from `pending` state via `setPending`. Replace the local-state-only "revoke" with:

```ts
  const revokeInvite = async (id: string) => {
    try {
      await api.patch(`/api/invites/${id}`, { status: 'revoked' });
      setPending(prev => prev.filter(p => p.id !== id));
      showToast?.('Invite revoked');
    } catch (e) {
      showToast?.(e instanceof Error ? e.message : 'Failed to revoke invite', 'error');
    }
  };
```

And replace the local `setPending(prev => prev.filter(p => p.id !== id))` invocations at the revoke site with `revokeInvite(p.id)`. (Search the file for `setPending(` to find them — there's typically one in the "Revoke" button onClick.)

- [ ] **Step 4: Wire create-invite to the API**

Find the create-invite button handler (an `onClick` that creates a new pending row locally). Replace its body with:

```ts
  const createInvite = async (email: string, role: 'manager' | 'purchaser') => {
    try {
      await api.post('/api/invites', { email, role });
      await reloadInvites();
      showToast?.(`Invitation sent to ${email}`);
    } catch (e) {
      showToast?.(e instanceof Error ? e.message : 'Failed to send invite', 'error');
    }
  };
```

(If the existing UI doesn't have a form, leave the button's existing onClick that opens the inviting modal alone — only wire the inviting modal's confirm/save handler to call `createInvite`.)

- [ ] **Step 5: TypeScript check + manual exercise**

```bash
pnpm --filter @recycle-erp/frontend exec tsc --noEmit
```
In browser at Members panel: confirm the seeded `noah.kim@…` invite shows up. Revoke it; reload; confirm it's gone.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "refactor(settings): load invites from /api/invites"
```

---

## Task 14: Replace pickLastSeen with API value

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

- [ ] **Step 1: Add last_seen_at to the Member type**

In `apps/frontend/src/pages/desktop/DesktopSettings.tsx`, update the `type Member` definition (around line 12) to add the field:

```ts
type Member = {
  id: string; email: string; name: string; initials: string;
  role: 'manager' | 'purchaser';
  team: string | null; phone: string | null; title: string | null;
  active: boolean; commission_rate: number;
  order_count: number; lifetime_profit: number;
  last_seen_at: string | null;
};
```

- [ ] **Step 2: Delete pickLastSeen**

In the same file, delete the comment line `// Last-seen text mocked client-side (no backend column yet).` and the `function pickLastSeen(id: string): string { ... }` declaration (around lines 428–433).

- [ ] **Step 3: Replace pickLastSeen call sites**

Search the file for `pickLastSeen(` — there's typically one or two call sites in the members table cell. Replace each like this:

Before:
```tsx
{pickLastSeen(m.id)}
```

After:
```tsx
{m.last_seen_at ? relTime(m.last_seen_at) : '—'}
```

If `relTime` is not yet imported at the top of the file, add it to the existing format import:

```ts
import { fmtUSD0, relTime } from '../../lib/format';
```

(`relTime` already exists in `apps/frontend/src/lib/format.ts` — used in DesktopMarket.)

- [ ] **Step 4: TypeScript check + browser exercise**

```bash
pnpm --filter @recycle-erp/frontend exec tsc --noEmit
```
In browser at Members panel: confirm each member shows a varied last-seen time matching the seed.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "refactor(settings): use last_seen_at from API instead of pickLastSeen"
```

---

## Task 15: Replace deriveCustomerSeed with API columns

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

- [ ] **Step 1: Extend Customer type with the new fields**

In `apps/frontend/src/pages/desktop/DesktopSettings.tsx`, update the `type Customer` definition (around line 20):

```ts
type Customer = {
  id: string; name: string; short_name: string | null; contact: string | null;
  region: string | null; terms: string; credit_limit: number | null;
  tags: string[]; notes: string | null; active: boolean;
  lifetime_revenue: number; order_count: number;
  lifecycle_status: 'Active' | 'Lead' | 'On hold' | 'Archived';
  outstanding_ar: number;
  last_order_at: string | null;
};
```

- [ ] **Step 2: Delete the deriveCustomerSeed block**

Find the comment `// ─── Customers ───` near line 1080, then delete:
- The block-comment "Customer status (Active/Lead/On hold/Archived)…" (a few lines)
- `type CustomerStatus = 'Active' | 'Lead' | 'On hold' | 'Archived';` — KEEP this line; it's still useful
- `const STATUS_CHIP: Record<CustomerStatus, …> = { … };` — KEEP this; pure presentation
- `function deriveCustomerSeed(c: Customer) { … }` — DELETE entire function

(`STATUS_CHIP` and `CustomerStatus` are presentation maps that stay in the frontend. Only `deriveCustomerSeed` is going.)

- [ ] **Step 3: Replace call sites**

Search the file for `deriveCustomerSeed(` — there's one call site that destructures `{ status, outstanding, lastDays }`. Replace the call and its destructure with direct field reads.

Before (typical pattern):
```ts
const { status, outstanding, lastDays } = deriveCustomerSeed(c);
```

After:
```ts
const status = c.lifecycle_status;
const outstanding = c.outstanding_ar;
const lastDays = c.last_order_at
  ? Math.max(0, Math.round((Date.now() - new Date(c.last_order_at).getTime()) / 86400000))
  : null;
```

If `lastDays` is rendered as `${lastDays}d ago`, render `lastDays === null ? '—' : `${lastDays}d ago`` at each render site.

- [ ] **Step 4: TypeScript check + browser exercise**

```bash
pnpm --filter @recycle-erp/frontend exec tsc --noEmit
```
In browser at Customers panel: confirm rows show varied Lifecycle status / AR / last-order matching the seed.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "refactor(settings): use customer lifecycle_status/AR/last_order from API"
```

---

## Task 16: Replace WAREHOUSE_EXTRAS with API values

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx`
- Modify: `apps/frontend/src/lib/types.ts`

- [ ] **Step 1: Extend the Warehouse type**

In `apps/frontend/src/lib/types.ts`, update `Warehouse`:

```ts
export type Warehouse = {
  id: string;
  name?: string;
  short: string;
  region: string;
  address?: string | null;
  manager?: string | null;
  managerPhone?: string | null;
  managerEmail?: string | null;
  timezone?: string | null;
  cutoffLocal?: string | null;
  sqft?: number | null;
};
```

- [ ] **Step 2: Delete WAREHOUSE_EXTRAS, WAREHOUSE_EXTRAS_DEFAULT, WarehouseExtras**

In `apps/frontend/src/pages/desktop/DesktopSettings.tsx`, find the comment `// ─── Warehouses ───` (around line 1478). Delete:
- The whole `// Backend Warehouse type only has id/name/short/region. …` comment block
- The `type WarehouseExtras = { … }` declaration
- `const WAREHOUSE_EXTRAS_DEFAULT: WarehouseExtras = { … };`
- `const WAREHOUSE_EXTRAS: Record<string, WarehouseExtras> = { … };`
- The `type WarehouseRow = Warehouse & WarehouseExtras & { active: boolean; receiving: boolean };` line

Replace with:

```ts
type WarehouseRow = Warehouse;
```

- [ ] **Step 3: Simplify the `reload()` to use API values directly**

Inside `function WarehousesPanel(...)` find:

```ts
  const reload = () => api.get<{ items: Warehouse[] }>('/api/warehouses')
    .then(r => {
      setWhs(r.items.map(w => ({
        ...w,
        ...(WAREHOUSE_EXTRAS[w.short] ?? WAREHOUSE_EXTRAS_DEFAULT),
        active: true,
        receiving: w.short !== 'HK',
      })));
    })
    .catch(console.error)
    .finally(() => setLoadedOnce(true));
```

Replace with:

```ts
  const reload = () => api.get<{ items: Warehouse[] }>('/api/warehouses')
    .then(r => setWhs(r.items))
    .catch(console.error)
    .finally(() => setLoadedOnce(true));
```

- [ ] **Step 4: Drop cutoff / sqft / capacity / active / receiving from the warehouse card JSX**

In the card-rendering JSX (around line 1565), keep ONLY the address/manager/timezone rows. Delete:

- The `const capColor = w.capacityPct > 85 ? … : 'var(--accent)';` and the surrounding ternary
- The `<div className="wh-row"><span className="wh-row-label">Receiving cutoff</span>…` block
- The `<div className="wh-row"><span className="wh-row-label">Floor area</span>…` block
- The entire `<div className="wh-capacity">…</div>` block
- The `<div className="wh-card-foot">` containing the Active/Receiving toggle rows

Also adjust the wrapping `<div key={w.id} className={'card wh-card' + (w.active ? '' : ' archived')}>` to drop the `active` reference:

```tsx
<div key={w.id} className="card wh-card">
```

And `updateRow` is no longer needed — delete it.

- [ ] **Step 5: Update panel subtitle to drop the sqft/capacity summary**

Replace:
```tsx
<SettingsHeader
  title="Warehouses"
  sub={`${activeCount} active · ${totalSqft.toLocaleString()} sq ft total · ${avgCapacity}% avg capacity`}
  actions={…}
/>
```

With:
```tsx
<SettingsHeader
  title="Warehouses"
  sub={`${whs.length} location${whs.length === 1 ? '' : 's'}`}
  actions={…}
/>
```

And delete `totalSqft`, `avgCapacity`, `activeCount` declarations above the return.

- [ ] **Step 6: TypeScript check + browser exercise**

```bash
pnpm --filter @recycle-erp/frontend exec tsc --noEmit
```
In browser at Warehouses panel: confirm cards show real address/manager/timezone from the DB (e.g. LA1 → 2401 E. 8th St) and the cutoff/sqft/capacity/active rows are gone.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/lib/types.ts apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "refactor(settings): warehouses read address/manager/timezone from API"
```

---

## Task 17: Replace TARGET_MARGIN with per-category default_margin

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopMarket.tsx`

- [ ] **Step 1: Delete TARGET_MARGIN**

In `apps/frontend/src/pages/desktop/DesktopMarket.tsx`, delete line 62:

```ts
const TARGET_MARGIN = 0.30;
```

- [ ] **Step 2: Read per-category margin from the catalog**

At the top of the file alongside other imports, add:

```ts
import { CATEGORIES } from '../../lib/catalog';
```

Then in the `allRows = useMemo(...)` block, replace:

```ts
  const allRows = useMemo(
    () => items.map(p => ({
      ...p,
      maxBuy: p.maxBuy || +(p.avgSell * (1 - TARGET_MARGIN)).toFixed(2),
    })),
    [items],
  );
```

With:

```ts
  const allRows = useMemo(
    () => {
      const marginById = Object.fromEntries(CATEGORIES.map(c => [c.id, c.defaultMargin]));
      return items.map(p => {
        const margin = marginById[p.category] ?? 0.30;
        return {
          ...p,
          maxBuy: p.maxBuy || +(p.avgSell * (1 - margin)).toFixed(2),
        };
      });
    },
    [items],
  );
```

- [ ] **Step 3: Fix the explanatory copy that referenced TARGET_MARGIN**

Search the file for `TARGET_MARGIN * 100` — there's one explainer line near line 297. Replace:

```tsx
Max buy = avg sell × (1 − {(TARGET_MARGIN * 100).toFixed(0)}% target margin)
```

With:

```tsx
Max buy = avg sell × (1 − per-category target margin)
```

- [ ] **Step 4: TypeScript check + browser exercise**

```bash
pnpm --filter @recycle-erp/frontend exec tsc --noEmit
```
In browser at the Market page: confirm RAM rows show maxBuy ≈ avgSell×0.62 and SSD rows show ≈ avgSell×0.72 (matching the seeded margins 0.38/0.28).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopMarket.tsx
git commit -m "refactor(market): per-category default_margin replaces TARGET_MARGIN"
```

---

## Task 18: Replace COMMISSION_RATE with API value

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopOrders.tsx`

- [ ] **Step 1: Delete the constant + helper**

In `apps/frontend/src/pages/desktop/DesktopOrders.tsx`, delete lines 33–36:

```ts
// Commission isn't stored on the order — derive it from profit using a flat
// 5% rate, matching design/dashboard.jsx (`o.profit * (o.commissionRate || 0.05)`).
const COMMISSION_RATE = 0.05;
const commissionFor = (o: OrderSummary) => +(o.profit * COMMISSION_RATE).toFixed(2);
```

- [ ] **Step 2: Replace commissionFor call sites**

Search the file for `commissionFor(`. There's one in `SORT_KEYS` and typically one or two in JSX cells. Replace each:

Before:
```ts
commission: o => commissionFor(o),
```

After:
```ts
commission: o => o.commission,
```

And in any JSX cell:

Before:
```tsx
{fmtUSD0(commissionFor(o))}
```

After:
```tsx
{fmtUSD0(o.commission)}
```

(Use whatever USD formatter the existing cell uses — `fmtUSD0` or `fmtUSD`. Keep the formatter the same.)

- [ ] **Step 3: TypeScript check + browser exercise**

```bash
pnpm --filter @recycle-erp/frontend exec tsc --noEmit
```
In browser at the Orders page: confirm the Commission column matches profit × 0.075 (the seeded default `users.commission_rate`).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopOrders.tsx
git commit -m "refactor(orders): use server-computed commission"
```

---

## Task 19: End-to-end verification

**Files:** none (read-only verification)

- [ ] **Step 1: Reset DB + reseed**

```bash
pnpm --filter @recycle-erp/backend migrate -- --reset
pnpm --filter @recycle-erp/backend seed
```
Expected: both exit 0.

- [ ] **Step 2: Restart backend + frontend**

In separate terminals:
```bash
pnpm --filter @recycle-erp/backend dev
pnpm --filter @recycle-erp/frontend dev
```

- [ ] **Step 3: Type-check the whole workspace**

```bash
pnpm -w exec tsc --noEmit
```
Expected: passes (no errors anywhere).

- [ ] **Step 4: Manual UI smoke**

Open the desktop app at `localhost:5173`, log in as `alex@recycleservers.io` / `demo`, and verify:

1. **Settings → Categories:** 6 categories listed, margins shown as percentages, toggling enabled persists across page reload.
2. **Settings → Members:** invite row `noah.kim@…` visible, each member's "Last seen" shows a varied time (not all the same).
3. **Settings → Warehouses:** each card shows real DB address/manager/timezone; no cutoff/floor-area/capacity/active rows.
4. **Settings → Customers:** Lifecycle status varies (some Active, some Lead, some On hold), outstanding AR varies, last-order date populated.
5. **Market page:** RAM row maxBuy = avgSell × 0.62, SSD row = avgSell × 0.72, HDD row = avgSell × 0.78.
6. **Orders page:** commission column = profit × 0.075 to within ±$0.01.

- [ ] **Step 5: Final commit if nothing else changed**

No code commit needed at this step. If the manual smoke surfaced UI tweaks, commit them; otherwise we're done.

---

## Self-review

After writing this plan, I cross-checked it against the spec sections:

- **`categories` table** → Task 1 (migration), Task 2 (seed), Task 3 (route), Task 6 (lookups), Task 10 (frontend lib), Task 11 (re-export), Task 12 (UI), Task 17 (Market consumer). ✓
- **`invites` table** → Task 1 (migration), Task 2 (seed), Task 4 (route), Task 5 (mount), Task 13 (UI). ✓
- **`warehouses` no migration / frontend-only fix** → Task 16. ✓ Notably, *no migration changes* here.
- **`users.last_seen_at`** → Task 1 (migration), Task 2 (seed), Task 8 (route), Task 14 (UI). ✓
- **`customers` status/AR/last_order** → Task 1 (migration), Task 2 (seed), Task 9 (route), Task 15 (UI). ✓
- **`/api/orders` commission** → Task 7 (route), Task 11 (type), Task 18 (UI). ✓
- **`/api/lookups` categories** → Task 6. ✓

Placeholder scan: no TBDs, no "add appropriate error handling," no "similar to Task N." Each code step contains the actual code.

Type consistency: `CategoryRow.defaultMargin` is `number` 0..1 everywhere; the UI multiplies by 100 only at the input field. `OrderSummary.commission` is `number` everywhere. `Warehouse.cutoffLocal` / `sqft` are kept in the type but not displayed in the new UI (the route still returns them; backwards-compatible).
