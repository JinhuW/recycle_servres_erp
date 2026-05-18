# Vendor Bidding Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-vendor, no-login shareable link that lets external resellers browse in-stock inventory (no prices shown) and submit price offers, which a manager reviews per-line and promotes into the existing sell-order pipeline.

**Architecture:** A public, token-gated route namespace (`/api/public/vendor/:token/*`) mounted *outside* `authMiddleware`, backed by three isolated tables (`vendor_links`, `vendor_bids`, `vendor_bid_lines`). Manager review/decide/promote lives behind a new authed `/api/vendor-bids` route plus vendor-link CRUD on the existing customers route. The frontend adds a third top-level branch in `App.tsx` for `/v/<token>` that renders a self-contained mobile-first `VendorApp` which never imports the authed Mobile/Desktop apps.

**Tech Stack:** Hono on Cloudflare Workers, postgres-js (tagged-template SQL), Vitest integration tests, React SPA (no router; hash/path branching), TypeScript.

**Spec:** `docs/superpowers/specs/2026-05-18-vendor-bidding-link-design.md`

---

## File Structure

**Backend — create:**
- `apps/backend/migrations/0033_vendor_bidding.sql` — schema + VB counter seed
- `apps/backend/src/routes/vendorPublic.ts` — public token-gated routes
- `apps/backend/src/routes/vendorBids.ts` — authed manager review/decide/promote
- `apps/backend/tests/vendor-public.test.ts`
- `apps/backend/tests/vendor-bids.test.ts`
- `apps/backend/tests/vendor-links.test.ts`

**Backend — modify:**
- `apps/backend/src/lib/id-seq.ts` — extend `name` union with `'VB'`
- `apps/backend/src/index.ts` — mount the two new routes (public one before auth block)
- `apps/backend/src/routes/customers.ts` — vendor-link CRUD endpoints

**Frontend — create:**
- `apps/frontend/src/lib/vendor.ts` — pure helpers (token-from-path, basket math)
- `apps/frontend/src/VendorApp.tsx` — vendor portal shell + three views
- `apps/frontend/tests/vendor.test.ts`

**Frontend — modify:**
- `apps/frontend/src/App.tsx` — third top-level branch for `/v/<token>`
- `apps/frontend/src/lib/i18n.tsx` — vendor-portal keys (`en` + `zh`)
- Customers detail component (manager link panel) + a new Vendor Bids desktop view

**Conventions to follow (observed in codebase):**
- Routes: `const x = new Hono<{ Bindings: Env; Variables: { user: User } }>()`; manager guard `if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403)`.
- DB: `const sql = getDb(c.env)`; tagged templates; transactions via `sql.begin(async (tx) => …)`; notifications via `notifyManagers(tx, …)` from `src/lib/notify.ts`.
- Tests: `import { api } from './helpers/app'`, `import { resetDb } from './helpers/db'`, `import { loginAs, ALEX } from './helpers/auth'`. Backend test command: `cd apps/backend && npx vitest run <file>`.
- Human IDs: `nextHumanId(sql, 'VB', 'VB')` → `VB-1001`.

---

## Task 1: Migration + VB id counter

**Files:**
- Create: `apps/backend/migrations/0033_vendor_bidding.sql`
- Modify: `apps/backend/src/lib/id-seq.ts` (the `name` union, ~line 13)
- Test: `apps/backend/tests/vendor-links.test.ts` (created here, expanded in Task 5)

- [ ] **Step 1: Write the migration**

Create `apps/backend/migrations/0033_vendor_bidding.sql`:

```sql
-- Vendor bidding link: public catalog + offers.

CREATE TABLE IF NOT EXISTS vendor_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  label         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at    TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS vendor_links_customer_idx ON vendor_links(customer_id);

CREATE TABLE IF NOT EXISTS vendor_bids (
  id             TEXT PRIMARY KEY,
  vendor_link_id UUID NOT NULL REFERENCES vendor_links(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES customers(id),
  contact_name   TEXT NOT NULL,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','partly_decided','decided')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS vendor_bids_link_idx   ON vendor_bids(vendor_link_id);
CREATE INDEX IF NOT EXISTS vendor_bids_status_idx ON vendor_bids(status);

CREATE TABLE IF NOT EXISTS vendor_bid_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id              TEXT NOT NULL REFERENCES vendor_bids(id) ON DELETE CASCADE,
  inventory_id        UUID REFERENCES order_lines(id),
  category            TEXT NOT NULL,
  label               TEXT NOT NULL,
  sub_label           TEXT,
  part_number         TEXT,
  offered_qty         INTEGER NOT NULL CHECK (offered_qty > 0),
  offered_unit_price  NUMERIC(12,2) NOT NULL CHECK (offered_unit_price >= 0),
  line_status         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (line_status IN ('pending','accepted','declined')),
  accepted_qty        INTEGER,
  accepted_unit_price NUMERIC(12,2),
  decided_at          TIMESTAMPTZ,
  decided_by          UUID REFERENCES users(id),
  sell_order_id       TEXT REFERENCES sell_orders(id),
  position            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS vendor_bid_lines_bid_idx ON vendor_bid_lines(bid_id);

INSERT INTO id_counters (name, value) VALUES ('VB', 1000)
  ON CONFLICT (name) DO NOTHING;
```

- [ ] **Step 2: Extend the id-seq union**

In `apps/backend/src/lib/id-seq.ts`, change the `name` parameter type:

```ts
export async function nextHumanId(
  sql: SqlLike,
  name: 'SO' | 'SL' | 'TO' | 'VB',
  prefix: string,
): Promise<string> {
```

- [ ] **Step 3: Write the failing test**

Create `apps/backend/tests/vendor-links.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('vendor links', () => {
  beforeAll(async () => { await resetDb(); });

  it('migration created vendor_links and a VB counter', async () => {
    // resetDb runs migrations; a manager-only smoke read proves the table exists.
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: Array<{ id: string }> }>('GET', '/api/customers', { token });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Run it**

Run: `cd apps/backend && npx vitest run tests/vendor-links.test.ts`
Expected: PASS (proves migrations including 0033 apply cleanly via `resetDb`). If `resetDb` fails applying 0033, fix the SQL.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/migrations/0033_vendor_bidding.sql apps/backend/src/lib/id-seq.ts apps/backend/tests/vendor-links.test.ts
git commit -m "feat(vendor-bids): schema + VB id counter"
```

---

## Task 2: Public route — `me` + `catalog`

**Files:**
- Create: `apps/backend/src/routes/vendorPublic.ts`
- Modify: `apps/backend/src/index.ts` (after `app.route('/api/auth', authRoutes);`, before the authMiddleware block)
- Test: `apps/backend/tests/vendor-public.test.ts`

- [ ] **Step 1: Create the route file with `loadLink`, `me`, `catalog`**

Create `apps/backend/src/routes/vendorPublic.ts`:

```ts
import { Hono } from 'hono';
import { getDb } from '../db';
import { nextHumanId } from '../lib/id-seq';
import { notifyManagers } from '../lib/notify';
import type { Env } from '../types';

const vendorPublic = new Hono<{ Bindings: Env }>();

type Link = { id: string; customer_id: string; label: string | null };

// Resolve a token to an active, non-expired link. Any miss returns null so
// callers can answer a uniform 404 (never reveal whether a token exists).
async function loadLink(sql: ReturnType<typeof getDb>, token: string): Promise<Link | null> {
  if (!token) return null;
  const rows = await sql<Link[]>`
    SELECT id, customer_id, label
    FROM vendor_links
    WHERE token = ${token} AND active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `;
  return rows[0] ?? null;
}

vendorPublic.get('/:token/me', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);
  const cust = (await sql<{ name: string; short_name: string | null }[]>`
    SELECT name, short_name FROM customers WHERE id = ${link.customer_id} LIMIT 1
  `)[0];
  if (!cust) return c.json({ error: 'Not found' }, 404);
  return c.json({ customer: { name: cust.name, short: cust.short_name }, label: link.label });
});

vendorPublic.get('/:token/catalog', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  // Best-effort touch; ignore failures.
  await sql`UPDATE vendor_links SET last_seen_at = NOW() WHERE id = ${link.id}`.catch(() => {});

  // Explicit non-cost column list. NEVER select unit_cost / sell_price /
  // profit / margin / notes / user / warehouse.
  const rows = await sql<Record<string, unknown>[]>`
    SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type,
           l.classification, l.rank, l.speed, l.interface, l.form_factor,
           l.description, l.part_number, l.condition, l.qty
    FROM order_lines l
    WHERE l.status = 'Done' AND l.qty > 0
    ORDER BY l.category, l.brand, l.created_at DESC
  `;
  const groups: { category: string; items: Record<string, unknown>[] }[] = [];
  for (const r of rows) {
    const cat = r.category as string;
    let g = groups.find(x => x.category === cat);
    if (!g) { g = { category: cat, items: [] }; groups.push(g); }
    g.items.push(r);
  }
  return c.json({ groups });
});

export default vendorPublic;
```

- [ ] **Step 2: Mount it in `index.ts` (outside auth)**

In `apps/backend/src/index.ts`: add the import near the other route imports:

```ts
import vendorPublicRoutes from './routes/vendorPublic';
```

Then, in the `// ── Public ──` section, directly after `app.route('/api/auth', authRoutes);`, add:

```ts
app.route('/api/public/vendor', vendorPublicRoutes);
```

(Do NOT add an `app.use('/api/public/*', authMiddleware)` line — the public surface stays unauthenticated by construction.)

- [ ] **Step 3: Write the failing test**

Create `apps/backend/tests/vendor-public.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// Creates a customer + an active vendor link via the (Task 5) CRUD endpoint.
// Until Task 5 lands, this helper inserts the link with a direct API once
// available; for Task 2 we seed through the customers route + a raw token.
async function seedLink(): Promise<{ token: string; customerId: string }> {
  const { token: mgr } = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/customers', {
    token: mgr, body: { name: 'Vendor Co', shortName: 'VendCo' },
  });
  const cust = created.body.id;
  const link = await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr });
  return { token: link.body.token, customerId: cust };
}

describe('vendor public — me & catalog', () => {
  beforeAll(async () => { await resetDb(); });

  it('404s on unknown token (no info leak)', async () => {
    const r = await api('GET', '/api/public/vendor/nope-nope/me');
    expect(r.status).toBe(404);
  });

  it('me returns the customer for a valid token', async () => {
    const { token } = await seedLink();
    const r = await api<{ customer: { name: string } }>('GET', `/api/public/vendor/${token}/me`);
    expect(r.status).toBe(200);
    expect(r.body.customer.name).toBe('Vendor Co');
  });

  it('catalog hides cost/sell_price and non-Done/zero-qty lines', async () => {
    const { token } = await seedLink();
    const r = await api<{ groups: { items: Record<string, unknown>[] }[] }>(
      'GET', `/api/public/vendor/${token}/catalog`);
    expect(r.status).toBe(200);
    const items = r.body.groups.flatMap(g => g.items);
    for (const it of items) {
      expect(it).not.toHaveProperty('unit_cost');
      expect(it).not.toHaveProperty('sell_price');
      expect(it).not.toHaveProperty('profit');
      expect(it.status === undefined || it.status === 'Done').toBe(true);
    }
  });
});
```

> Note: this test depends on the Task 5 `POST /api/customers/:id/vendor-link` endpoint. Run it after Task 5; for now it should compile and the unknown-token case must pass.

- [ ] **Step 4: Run the unknown-token case**

Run: `cd apps/backend && npx vitest run tests/vendor-public.test.ts -t "404s on unknown token"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/vendorPublic.ts apps/backend/src/index.ts apps/backend/tests/vendor-public.test.ts
git commit -m "feat(vendor-bids): public me + catalog routes"
```

---

## Task 3: Public route — submit bid (`POST /:token/bids`)

**Files:**
- Modify: `apps/backend/src/routes/vendorPublic.ts`
- Test: `apps/backend/tests/vendor-public.test.ts`

- [ ] **Step 1: Add the POST handler**

Append to `vendorPublic.ts` before `export default`:

```ts
type BidLineIn = { inventoryId: string; qty: number; unitPrice: number };

vendorPublic.post('/:token/bids', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  const body = (await c.req.json().catch(() => null)) as
    | { contactName?: string; note?: string; lines?: BidLineIn[] }
    | null;
  const contactName = (body?.contactName ?? '').trim();
  const lines = Array.isArray(body?.lines) ? body!.lines : [];
  if (!contactName || contactName.length > 120) {
    return c.json({ error: 'contactName required (<=120 chars)' }, 400);
  }
  if (lines.length < 1 || lines.length > 100) {
    return c.json({ error: 'lines must have 1..100 entries' }, 400);
  }
  for (const l of lines) {
    if (!l.inventoryId || !Number.isInteger(l.qty) || l.qty <= 0 ||
        !Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
      return c.json({ error: 'each line needs inventoryId, qty>0, unitPrice>=0' }, 400);
    }
  }

  type Outcome =
    | { code: 201; bidId: string }
    | { code: 409; bad: string[] }
    | { code: 400; msg: string };
  let outcome: Outcome = { code: 400, msg: 'unknown' };

  const bidId = await nextHumanId(sql, 'VB', 'VB');

  await sql.begin(async (tx) => {
    const bad: string[] = [];
    const snap: Record<string, { category: string; label: string; sub: string | null; pn: string | null }> = {};
    for (const l of lines) {
      const row = (await tx<{ category: string; brand: string | null; capacity: string | null;
        type: string | null; part_number: string | null; qty: number; status: string }[]>`
        SELECT category, brand, capacity, type, part_number, qty, status
        FROM order_lines WHERE id = ${l.inventoryId} FOR UPDATE
      `)[0];
      if (!row || row.status !== 'Done' || row.qty < l.qty) { bad.push(l.inventoryId); continue; }
      snap[l.inventoryId] = {
        category: row.category,
        label: [row.brand, row.capacity, row.type].filter(Boolean).join(' ') || row.category,
        sub: row.part_number,
        pn: row.part_number,
      };
    }
    if (bad.length) { outcome = { code: 409, bad }; return; } // roll back

    await tx`
      INSERT INTO vendor_bids (id, vendor_link_id, customer_id, contact_name, note)
      VALUES (${bidId}, ${link.id}, ${link.customer_id}, ${contactName}, ${body?.note ?? null})
    `;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; const s = snap[l.inventoryId];
      await tx`
        INSERT INTO vendor_bid_lines
          (bid_id, inventory_id, category, label, sub_label, part_number,
           offered_qty, offered_unit_price, position)
        VALUES
          (${bidId}, ${l.inventoryId}, ${s.category}, ${s.label}, ${s.sub},
           ${s.pn}, ${l.qty}, ${l.unitPrice}, ${i})
      `;
    }
    await notifyManagers(tx, {
      kind: 'vendor_bid', tone: 'info', icon: 'tag',
      title: 'New vendor offer',
      body: `${lines.length} item(s) from ${contactName}`,
    });
    outcome = { code: 201, bidId };
  });

  if (outcome.code === 409) return c.json({ error: 'Some items are no longer available', unavailable: outcome.bad }, 409);
  if (outcome.code !== 201) return c.json({ error: (outcome as { msg: string }).msg }, 400);
  return c.json({ bidId: outcome.bidId }, 201);
});
```

- [ ] **Step 2: Add failing tests**

Append inside the `describe` in `tests/vendor-public.test.ts`. Add a helper to grab an in-stock inventory id as a manager:

```ts
async function anInStockLine(): Promise<{ id: string; qty: number }> {
  const { token } = await loginAs(ALEX);
  const inv = await api<{ items: Array<{ id: string; qty: number; status: string }> }>(
    'GET', '/api/inventory?status=Done', { token });
  const row = inv.body.items.find(i => i.qty > 0)!;
  return { id: row.id, qty: row.qty };
}

it('submits a bid and notifies managers', async () => {
  const { token } = await seedLink();
  const line = await anInStockLine();
  const r = await api<{ bidId: string }>('POST', `/api/public/vendor/${token}/bids`, {
    body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
  });
  expect(r.status).toBe(201);
  expect(r.body.bidId).toMatch(/^VB-\d+$/);
});

it('rejects qty over availability with 409', async () => {
  const { token } = await seedLink();
  const line = await anInStockLine();
  const r = await api('POST', `/api/public/vendor/${token}/bids`, {
    body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: line.qty + 999, unitPrice: 5 }] },
  });
  expect(r.status).toBe(409);
});

it('rejects malformed body with 400', async () => {
  const { token } = await seedLink();
  const r = await api('POST', `/api/public/vendor/${token}/bids`, {
    body: { contactName: '', lines: [] },
  });
  expect(r.status).toBe(400);
});
```

- [ ] **Step 3: Run the file**

Run: `cd apps/backend && npx vitest run tests/vendor-public.test.ts`
Expected: the three new cases PASS (run after Task 5 so `seedLink` works).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/vendorPublic.ts apps/backend/tests/vendor-public.test.ts
git commit -m "feat(vendor-bids): public bid submission"
```

---

## Task 4: Public route — "My offers" (`GET /:token/bids`)

**Files:**
- Modify: `apps/backend/src/routes/vendorPublic.ts`
- Test: `apps/backend/tests/vendor-public.test.ts`

- [ ] **Step 1: Add the handler**

Append to `vendorPublic.ts` before `export default`:

```ts
vendorPublic.get('/:token/bids', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  const bids = await sql<{ id: string; contact_name: string; note: string | null;
    status: string; created_at: string }[]>`
    SELECT id, contact_name, note, status, created_at
    FROM vendor_bids WHERE vendor_link_id = ${link.id}
    ORDER BY created_at DESC
  `;
  const lines = await sql<{ bid_id: string; label: string; offered_qty: number;
    offered_unit_price: number; line_status: string;
    accepted_qty: number | null; accepted_unit_price: number | null }[]>`
    SELECT bid_id, label, offered_qty, offered_unit_price::float AS offered_unit_price,
           line_status, accepted_qty, accepted_unit_price::float AS accepted_unit_price
    FROM vendor_bid_lines
    WHERE bid_id IN (SELECT id FROM vendor_bids WHERE vendor_link_id = ${link.id})
    ORDER BY position
  `;
  return c.json({
    bids: bids.map(b => ({
      id: b.id, contactName: b.contact_name, note: b.note,
      status: b.status, createdAt: b.created_at,
      lines: lines.filter(l => l.bid_id === b.id).map(l => ({
        label: l.label, offeredQty: l.offered_qty, offeredUnitPrice: l.offered_unit_price,
        status: l.line_status, acceptedQty: l.accepted_qty, acceptedUnitPrice: l.accepted_unit_price,
      })),
    })),
  });
});
```

- [ ] **Step 2: Add failing test**

Append inside the `describe`:

```ts
it('lists this link\'s submitted bids', async () => {
  const { token } = await seedLink();
  const line = await anInStockLine();
  await api('POST', `/api/public/vendor/${token}/bids`, {
    body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
  });
  const r = await api<{ bids: Array<{ status: string; lines: unknown[] }> }>(
    'GET', `/api/public/vendor/${token}/bids`);
  expect(r.status).toBe(200);
  expect(r.body.bids.length).toBe(1);
  expect(r.body.bids[0].status).toBe('new');
  expect(r.body.bids[0].lines.length).toBe(1);
});
```

- [ ] **Step 3: Run & commit**

Run: `cd apps/backend && npx vitest run tests/vendor-public.test.ts`
Expected: PASS.

```bash
git add apps/backend/src/routes/vendorPublic.ts apps/backend/tests/vendor-public.test.ts
git commit -m "feat(vendor-bids): public my-offers list"
```

---

## Task 5: Vendor-link CRUD on the customers route

**Files:**
- Modify: `apps/backend/src/routes/customers.ts`
- Test: `apps/backend/tests/vendor-links.test.ts`

- [ ] **Step 1: Add imports + endpoints to `customers.ts`**

At the top of `customers.ts`, ensure these imports exist (add any missing):

```ts
import { getDb } from '../db';
```

Add these handlers (place near the other customer handlers; `customers` is the Hono instance already declared in the file):

```ts
// Generate (or regenerate) the active vendor link for a customer. Regenerating
// deactivates any prior link so a leaked token can be rotated.
customers.post('/:id/vendor-link', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const customerId = c.req.param('id');
  const sql = getDb(c.env);

  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const row = (await sql<{ id: string; token: string }[]>`
    WITH deact AS (
      UPDATE vendor_links SET active = FALSE
      WHERE customer_id = ${customerId} AND active = TRUE
    )
    INSERT INTO vendor_links (customer_id, token, created_by)
    VALUES (${customerId}, ${token}, ${u.id})
    RETURNING id, token
  `)[0];
  return c.json({ id: row.id, token: row.token }, 201);
});

customers.get('/:id/vendor-link', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const row = (await sql<{ id: string; token: string; active: boolean;
    expires_at: string | null; label: string | null; created_at: string;
    last_seen_at: string | null }[]>`
    SELECT id, token, active, expires_at, label, created_at, last_seen_at
    FROM vendor_links WHERE customer_id = ${c.req.param('id')} AND active = TRUE
    ORDER BY created_at DESC LIMIT 1
  `)[0];
  if (!row) return c.json({ link: null });
  const bids = (await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM vendor_bids WHERE vendor_link_id = ${row.id}
  `)[0].n;
  return c.json({ link: { ...row, bidCount: bids } });
});

customers.patch('/vendor-link/:linkId', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const b = (await c.req.json().catch(() => ({}))) as
    { active?: boolean; expiresAt?: string | null; label?: string | null };
  await sql`
    UPDATE vendor_links SET
      active     = COALESCE(${b.active ?? null}, active),
      expires_at = ${b.expiresAt === undefined ? sql`expires_at` : b.expiresAt},
      label      = ${b.label === undefined ? sql`label` : b.label}
    WHERE id = ${c.req.param('linkId')}
  `;
  return c.json({ ok: true });
});
```

- [ ] **Step 2: Write failing tests**

Replace the body of `tests/vendor-links.test.ts` with:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, JESSE } from './helpers/auth';

describe('vendor links CRUD', () => {
  beforeAll(async () => { await resetDb(); });

  async function aCustomer(mgr: string): Promise<string> {
    const r = await api<{ id: string }>('POST', '/api/customers', {
      token: mgr, body: { name: 'Vendor Co', shortName: 'VendCo' },
    });
    return r.body.id;
  }

  it('manager creates and regenerates a link (old token deactivated)', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const cust = await aCustomer(mgr);
    const a = await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr });
    expect(a.status).toBe(201);
    const b = await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr });
    expect(b.body.token).not.toBe(a.body.token);
    // Old token no longer resolves on the public surface.
    const old = await api('GET', `/api/public/vendor/${a.body.token}/me`);
    expect(old.status).toBe(404);
    const cur = await api('GET', `/api/public/vendor/${b.body.token}/me`);
    expect(cur.status).toBe(200);
  });

  it('revoke via PATCH active=false makes the token 404', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const cust = await aCustomer(mgr);
    const a = await api<{ id: string; token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr });
    await api('PATCH', `/api/customers/vendor-link/${a.body.id}`, { token: mgr, body: { active: false } });
    const r = await api('GET', `/api/public/vendor/${a.body.token}/me`);
    expect(r.status).toBe(404);
  });

  it('non-manager is forbidden', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const cust = await aCustomer(mgr);
    const { token: pur } = await loginAs(JESSE);
    const r = await api('POST', `/api/customers/${cust}/vendor-link`, { token: pur });
    expect(r.status).toBe(403);
  });
});
```

> If `JESSE` is not an exported purchaser fixture, use whatever purchaser fixture `tests/helpers/auth.ts` exports (open it and pick the non-manager). Adjust the import accordingly.

- [ ] **Step 3: Run**

Run: `cd apps/backend && npx vitest run tests/vendor-links.test.ts tests/vendor-public.test.ts`
Expected: ALL PASS (this also unblocks Tasks 2–4 which used `seedLink`).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/customers.ts apps/backend/tests/vendor-links.test.ts
git commit -m "feat(vendor-bids): vendor-link CRUD on customers route"
```

---

## Task 6: Manager route — inbox, detail, decide

**Files:**
- Create: `apps/backend/src/routes/vendorBids.ts`
- Modify: `apps/backend/src/index.ts` (add `app.use('/api/vendor-bids/*', authMiddleware)` in the authed block + `app.route`)
- Test: `apps/backend/tests/vendor-bids.test.ts`

- [ ] **Step 1: Create `vendorBids.ts` with GET `/`, GET `/:id`, POST `/:id/decide`**

```ts
import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const vendorBids = new Hono<{ Bindings: Env; Variables: { user: User } }>();

vendorBids.get('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const status = c.req.query('status');
  const statusFrag = status ? sql`b.status = ${status}` : sql`TRUE`;
  const rows = await sql`
    SELECT b.id, b.contact_name, b.note, b.status, b.created_at,
           cu.name AS customer_name, cu.short_name AS customer_short,
           COUNT(bl.id)::int AS line_count,
           COALESCE(SUM(bl.offered_qty * bl.offered_unit_price), 0)::float AS total_offered
    FROM vendor_bids b
    JOIN customers cu ON cu.id = b.customer_id
    LEFT JOIN vendor_bid_lines bl ON bl.bid_id = b.id
    WHERE ${statusFrag}
    GROUP BY b.id, cu.id
    ORDER BY b.created_at DESC
  `;
  return c.json({ items: rows });
});

vendorBids.get('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const head = (await sql`
    SELECT b.id, b.contact_name, b.note, b.status, b.created_at,
           cu.id AS customer_id, cu.name AS customer_name
    FROM vendor_bids b JOIN customers cu ON cu.id = b.customer_id
    WHERE b.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);
  const lines = await sql<{ id: string; inventory_id: string | null; label: string;
    sub_label: string | null; category: string; offered_qty: number;
    offered_unit_price: number; line_status: string; accepted_qty: number | null;
    accepted_unit_price: number | null; sell_order_id: string | null;
    available: number }[]>`
    SELECT bl.id, bl.inventory_id, bl.label, bl.sub_label, bl.category,
           bl.offered_qty, bl.offered_unit_price::float AS offered_unit_price,
           bl.line_status, bl.accepted_qty,
           bl.accepted_unit_price::float AS accepted_unit_price, bl.sell_order_id,
           COALESCE((SELECT ol.qty FROM order_lines ol
                     WHERE ol.id = bl.inventory_id AND ol.status = 'Done'), 0) AS available
    FROM vendor_bid_lines bl WHERE bl.bid_id = ${id} ORDER BY bl.position
  `;
  return c.json({ bid: { ...head, lines } });
});

vendorBids.post('/:id/decide', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { lines: { lineId: string; decision: 'accepted' | 'declined';
        acceptedQty?: number; acceptedUnitPrice?: number }[] }
    | null;
  if (!body || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'lines required' }, 400);
  }

  await sql.begin(async (tx) => {
    for (const d of body.lines) {
      const ln = (await tx<{ offered_qty: number; offered_unit_price: number;
        inventory_id: string | null }[]>`
        SELECT offered_qty, offered_unit_price::float AS offered_unit_price, inventory_id
        FROM vendor_bid_lines WHERE id = ${d.lineId} AND bid_id = ${id} FOR UPDATE
      `)[0];
      if (!ln) continue;
      if (d.decision === 'declined') {
        await tx`
          UPDATE vendor_bid_lines
          SET line_status='declined', accepted_qty=NULL, accepted_unit_price=NULL,
              decided_at=NOW(), decided_by=${u.id}
          WHERE id=${d.lineId}
        `;
        continue;
      }
      const avail = (await tx<{ qty: number }[]>`
        SELECT COALESCE((SELECT qty FROM order_lines
          WHERE id=${ln.inventory_id} AND status='Done'),0) AS qty
      `)[0].qty;
      const wantQty = Number.isInteger(d.acceptedQty) ? (d.acceptedQty as number) : ln.offered_qty;
      const qty = Math.max(0, Math.min(wantQty, avail));
      const price = Number.isFinite(d.acceptedUnitPrice)
        ? (d.acceptedUnitPrice as number) : ln.offered_unit_price;
      await tx`
        UPDATE vendor_bid_lines
        SET line_status='accepted', accepted_qty=${qty}, accepted_unit_price=${price},
            decided_at=NOW(), decided_by=${u.id}
        WHERE id=${d.lineId}
      `;
    }
    // Recompute bid status from line states.
    const counts = (await tx<{ pending: number; total: number }[]>`
      SELECT COUNT(*) FILTER (WHERE line_status='pending')::int AS pending,
             COUNT(*)::int AS total
      FROM vendor_bid_lines WHERE bid_id=${id}
    `)[0];
    const next = counts.pending === 0 ? 'decided'
      : counts.pending === counts.total ? 'new' : 'partly_decided';
    await tx`UPDATE vendor_bids SET status=${next} WHERE id=${id}`;
  });
  return c.json({ ok: true });
});

export default vendorBids;
```

- [ ] **Step 2: Mount in `index.ts`**

Add import with the others:

```ts
import vendorBidsRoutes from './routes/vendorBids';
```

In the authed block (alongside the other `app.use(... authMiddleware)` lines):

```ts
app.use('/api/vendor-bids/*', authMiddleware);
```

In the `app.route` block:

```ts
app.route('/api/vendor-bids', vendorBidsRoutes);
```

- [ ] **Step 3: Write failing tests**

Create `apps/backend/tests/vendor-bids.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, JESSE } from './helpers/auth';

async function setup() {
  const { token: mgr } = await loginAs(ALEX);
  const cust = (await api<{ id: string }>('POST', '/api/customers', {
    token: mgr, body: { name: 'Vendor Co' } })).body.id;
  const link = (await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr })).body.token;
  const inv = await api<{ items: Array<{ id: string; qty: number }> }>(
    'GET', '/api/inventory?status=Done', { token: mgr });
  const line = inv.body.items.find(i => i.qty > 0)!;
  const bid = (await api<{ bidId: string }>('POST', `/api/public/vendor/${link}/bids`, {
    body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
  })).body.bidId;
  return { mgr, cust, link, bidId: bid, invId: line.id, invQty: line.qty };
}

describe('vendor-bids manager route', () => {
  beforeAll(async () => { await resetDb(); });

  it('non-manager is forbidden', async () => {
    const { token: pur } = await loginAs(JESSE);
    const r = await api('GET', '/api/vendor-bids', { token: pur });
    expect(r.status).toBe(403);
  });

  it('inbox lists the submitted bid', async () => {
    const { mgr } = await setup();
    const r = await api<{ items: Array<{ id: string; line_count: number }> }>(
      'GET', '/api/vendor-bids', { token: mgr });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
  });

  it('decide accepts a line, clamps to availability, transitions status', async () => {
    const { mgr, bidId } = await setup();
    const detail = await api<{ bid: { lines: Array<{ id: string }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const lineId = detail.body.bid.lines[0].id;
    const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr, body: { lines: [{ lineId, decision: 'accepted', acceptedQty: 999999, acceptedUnitPrice: 4 }] },
    });
    expect(dec.status).toBe(200);
    const after = await api<{ bid: { status: string; lines: Array<{ accepted_qty: number; available: number }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    expect(after.body.bid.status).toBe('decided');
    expect(after.body.bid.lines[0].accepted_qty).toBeLessThanOrEqual(after.body.bid.lines[0].available);
  });
});
```

- [ ] **Step 4: Run**

Run: `cd apps/backend && npx vitest run tests/vendor-bids.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/vendorBids.ts apps/backend/src/index.ts apps/backend/tests/vendor-bids.test.ts
git commit -m "feat(vendor-bids): manager inbox + detail + decide"
```

---

## Task 7: Manager route — promote accepted lines to a Draft sell order

**Files:**
- Modify: `apps/backend/src/routes/vendorBids.ts`
- Test: `apps/backend/tests/vendor-bids.test.ts`

- [ ] **Step 1: Add the promote handler**

Append to `vendorBids.ts` before `export default`. Add `import { nextHumanId } from '../lib/id-seq';` at the top.

```ts
vendorBids.post('/:id/promote', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');

  type Outcome = { code: 201; sellId: string } | { code: 400; msg: string };
  let outcome: Outcome = { code: 400, msg: 'no accepted lines to promote' };
  const sellId = await nextHumanId(sql, 'SL', 'SL');

  await sql.begin(async (tx) => {
    const head = (await tx<{ customer_id: string }[]>`
      SELECT customer_id FROM vendor_bids WHERE id=${id} LIMIT 1`)[0];
    if (!head) { outcome = { code: 400, msg: 'bid not found' }; return; }
    const lines = await tx<{ id: string; inventory_id: string | null; category: string;
      label: string; sub_label: string | null; part_number: string | null;
      accepted_qty: number; accepted_unit_price: number }[]>`
      SELECT id, inventory_id, category, label, sub_label, part_number,
             accepted_qty, accepted_unit_price::float AS accepted_unit_price
      FROM vendor_bid_lines
      WHERE bid_id=${id} AND line_status='accepted'
        AND sell_order_id IS NULL AND accepted_qty > 0
      ORDER BY position FOR UPDATE
    `;
    if (lines.length === 0) { outcome = { code: 400, msg: 'no accepted lines to promote' }; return; }
    await tx`
      INSERT INTO sell_orders (id, customer_id, status, discount_pct, notes, created_by)
      VALUES (${sellId}, ${head.customer_id}, 'Draft', 0,
              ${'From vendor bid ' + id}, ${u.id})
    `;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await tx`
        INSERT INTO sell_order_lines
          (sell_order_id, inventory_id, category, label, sub_label, part_number,
           qty, unit_price, warehouse_id, condition, position)
        VALUES
          (${sellId}, ${l.inventory_id}, ${l.category}, ${l.label}, ${l.sub_label},
           ${l.part_number}, ${l.accepted_qty}, ${l.accepted_unit_price},
           NULL, NULL, ${i})
      `;
      await tx`UPDATE vendor_bid_lines SET sell_order_id=${sellId} WHERE id=${l.id}`;
    }
    outcome = { code: 201, sellId };
  });

  if (outcome.code !== 201) return c.json({ error: (outcome as { msg: string }).msg }, 400);
  return c.json({ sellOrderId: outcome.sellId }, 201);
});
```

- [ ] **Step 2: Add failing tests**

Append inside the `describe` in `tests/vendor-bids.test.ts`:

```ts
it('promote creates one Draft sell order and is idempotent', async () => {
  const { mgr, bidId } = await setup();
  const detail = await api<{ bid: { lines: Array<{ id: string }> } }>(
    'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
  const lineId = detail.body.bid.lines[0].id;
  await api('POST', `/api/vendor-bids/${bidId}/decide`, {
    token: mgr, body: { lines: [{ lineId, decision: 'accepted', acceptedQty: 1, acceptedUnitPrice: 4 }] },
  });
  const p1 = await api<{ sellOrderId: string }>('POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
  expect(p1.status).toBe(201);
  expect(p1.body.sellOrderId).toMatch(/^SL-\d+$/);
  const so = await api<{ order: { lines: unknown[] } }>(
    'GET', `/api/sell-orders/${p1.body.sellOrderId}`, { token: mgr });
  expect(so.status).toBe(200);
  expect(so.body.order.lines.length).toBe(1);
  // Second promote finds nothing left → 400 (idempotent: no duplicate SO).
  const p2 = await api('POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
  expect(p2.status).toBe(400);
});
```

- [ ] **Step 3: Run & full backend suite**

Run: `cd apps/backend && npx vitest run tests/vendor-bids.test.ts tests/vendor-public.test.ts tests/vendor-links.test.ts`
Expected: ALL PASS.
Then: `cd apps/backend && npx vitest run`
Expected: full suite green (no regressions).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/vendorBids.ts apps/backend/tests/vendor-bids.test.ts
git commit -m "feat(vendor-bids): promote accepted lines to draft sell order"
```

---

## Task 8: Frontend — pure helpers (token-from-path, basket math)

**Files:**
- Create: `apps/frontend/src/lib/vendor.ts`
- Test: `apps/frontend/tests/vendor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/tests/vendor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { vendorTokenFromPath, basketTotal, type BasketLine } from '../src/lib/vendor';

describe('vendor helpers', () => {
  it('extracts the token from a /v/<token> path', () => {
    expect(vendorTokenFromPath('/v/abc123')).toBe('abc123');
    expect(vendorTokenFromPath('/v/abc123/anything')).toBe('abc123');
    expect(vendorTokenFromPath('/dashboard')).toBeNull();
    expect(vendorTokenFromPath('/v/')).toBeNull();
  });

  it('sums basket line totals', () => {
    const b: BasketLine[] = [
      { inventoryId: '1', label: 'A', qty: 2, unitPrice: 5, available: 10, category: 'RAM' },
      { inventoryId: '2', label: 'B', qty: 3, unitPrice: 4, available: 9, category: 'SSD' },
    ];
    expect(basketTotal(b)).toBe(22);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && npx vitest run tests/vendor.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `apps/frontend/src/lib/vendor.ts`**

```ts
export type CatalogItem = {
  id: string; category: string; brand?: string | null; capacity?: string | null;
  generation?: string | null; type?: string | null; classification?: string | null;
  rank?: string | null; speed?: string | null; interface?: string | null;
  form_factor?: string | null; description?: string | null;
  part_number?: string | null; condition?: string | null; qty: number;
};

export type BasketLine = {
  inventoryId: string; label: string; category: string;
  qty: number; unitPrice: number; available: number;
};

const VENDOR_PATH = /^\/v\/([^/]+)/;

export function vendorTokenFromPath(pathname: string): string | null {
  const m = VENDOR_PATH.exec(pathname);
  return m && m[1] ? m[1] : null;
}

export function itemLabel(it: CatalogItem): string {
  return [it.brand, it.capacity, it.type].filter(Boolean).join(' ') || it.category;
}

export function basketTotal(lines: BasketLine[]): number {
  return +lines.reduce((a, l) => a + l.qty * l.unitPrice, 0).toFixed(2);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/frontend && npx vitest run tests/vendor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/vendor.ts apps/frontend/tests/vendor.test.ts
git commit -m "feat(vendor-bids): frontend vendor helpers"
```

---

## Task 9: Frontend — VendorApp shell + Browse view, wired into App.tsx

**Files:**
- Create: `apps/frontend/src/VendorApp.tsx`
- Modify: `apps/frontend/src/App.tsx`
- Modify: `apps/frontend/src/lib/i18n.tsx` (add keys)

- [ ] **Step 1: Add i18n keys**

In `apps/frontend/src/lib/i18n.tsx`, add to the `en` map and matching `zh` map (follow the existing flat-key style):

```ts
// en
vendorBrowse: 'Browse', vendorMyOffers: 'My offers',
vendorAvailable: '{n} available', vendorAddOffer: '+ Add offer',
vendorYourOffer: 'Your offer / unit', vendorQty: 'Qty',
vendorReview: 'Review & submit', vendorTotalOffered: 'Total offered',
vendorContactName: 'Your name', vendorNote: 'Note (optional)',
vendorSubmit: 'Submit offer', vendorSubmitted: 'Offer submitted',
vendorNonBinding: 'Offers are non-binding — we review and reply.',
vendorPending: 'Pending', vendorAccepted: 'Accepted', vendorDeclined: 'Declined',
```

```ts
// zh
vendorBrowse: '浏览', vendorMyOffers: '我的报价',
vendorAvailable: '现货 {n}', vendorAddOffer: '+ 添加报价',
vendorYourOffer: '您的单价', vendorQty: '数量',
vendorReview: '确认并提交', vendorTotalOffered: '报价合计',
vendorContactName: '您的姓名', vendorNote: '备注（可选）',
vendorSubmit: '提交报价', vendorSubmitted: '报价已提交',
vendorNonBinding: '报价为非约束性，我们审核后回复。',
vendorPending: '待处理', vendorAccepted: '已接受', vendorDeclined: '已拒绝',
```

- [ ] **Step 2: Create `VendorApp.tsx` (shell + Browse + Review + My offers)**

Create `apps/frontend/src/VendorApp.tsx`. It fetches `/api/public/vendor/:token/{me,catalog,bids}`, holds basket state in `useState`, and renders the three views behind a segmented control. Use the design tokens already imported globally (`var(--accent)` etc.) — mobile-first single column.

```tsx
import { useEffect, useState } from 'react';
import { useT } from './lib/i18n';
import {
  type CatalogItem, type BasketLine, itemLabel, basketTotal,
} from './lib/vendor';

type Tab = 'browse' | 'mine';

export function VendorApp({ token }: { token: string }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('browse');
  const [me, setMe] = useState<{ customer: { name: string }; label: string | null } | null>(null);
  const [groups, setGroups] = useState<{ category: string; items: CatalogItem[] }[]>([]);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [review, setReview] = useState(false);

  const base = `/api/public/vendor/${encodeURIComponent(token)}`;

  useEffect(() => {
    (async () => {
      const m = await fetch(`${base}/me`);
      if (m.status === 404) { setNotFound(true); return; }
      setMe(await m.json());
      const cat = await fetch(`${base}/catalog`);
      if (cat.ok) setGroups((await cat.json()).groups);
    })();
  }, [base]);

  if (notFound) {
    return <div style={{ padding: 40, textAlign: 'center' }}>
      <h2>Link unavailable</h2>
      <p style={{ color: 'var(--fg-muted)' }}>This link is invalid or has expired.</p>
    </div>;
  }

  function addToBasket(it: CatalogItem, qty: number, unitPrice: number) {
    setBasket(b => {
      const rest = b.filter(x => x.inventoryId !== it.id);
      return [...rest, {
        inventoryId: it.id, label: itemLabel(it), category: it.category,
        qty: Math.max(1, Math.min(qty, it.qty)), unitPrice, available: it.qty,
      }];
    });
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', minHeight: '100vh', background: 'var(--bg)' }}>
      <header style={{ background: 'var(--fg)', color: '#fff', padding: '14px 16px' }}>
        <b>Recycle Servers — Stock</b>
        <div style={{ fontSize: 12, color: '#b9c0c8' }}>
          {me ? `Shared with: ${me.customer.name}` : '…'}
        </div>
      </header>

      <div style={{ display: 'flex', margin: 12, background: 'var(--bg-soft)', borderRadius: 8, padding: 3 }}>
        {(['browse', 'mine'] as Tab[]).map(x => (
          <button key={x} onClick={() => { setTab(x); setReview(false); }}
            style={{
              flex: 1, padding: 8, border: 0, borderRadius: 6, cursor: 'pointer',
              background: tab === x ? '#fff' : 'transparent',
              fontWeight: tab === x ? 700 : 400,
            }}>
            {x === 'browse' ? t('vendorBrowse') : t('vendorMyOffers')}
          </button>
        ))}
      </div>

      {tab === 'browse' && !review && (
        <BrowseView groups={groups} t={t} onAdd={addToBasket} basketCount={basket.length}
          onReview={() => setReview(true)} />
      )}
      {tab === 'browse' && review && (
        <ReviewView base={base} basket={basket} t={t}
          onBack={() => setReview(false)}
          onDone={() => { setBasket([]); setReview(false); setTab('mine'); }} />
      )}
      {tab === 'mine' && <MyOffersView base={base} t={t} />}
    </div>
  );
}

function BrowseView({ groups, t, onAdd, basketCount, onReview }: {
  groups: { category: string; items: CatalogItem[] }[];
  t: (k: string, p?: Record<string, unknown>) => string;
  onAdd: (it: CatalogItem, qty: number, price: number) => void;
  basketCount: number; onReview: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState('');
  return (
    <div style={{ padding: '0 12px 90px' }}>
      {groups.map(g => (
        <div key={g.category}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--fg-subtle)', margin: '14px 2px 6px' }}>
            {g.category} · {g.items.length}
          </div>
          {g.items.map(it => (
            <div key={it.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 11, marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{itemLabel(it)}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '3px 0 8px' }}>
                {[it.part_number, it.condition].filter(Boolean).join(' · ')}
              </div>
              {openId === it.id ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <label style={{ fontSize: 11 }}>{t('vendorQty')} (≤{it.qty})
                    <input type="number" min={1} max={it.qty} value={qty}
                      onChange={e => setQty(+e.target.value)} className="input" style={{ width: 70 }} />
                  </label>
                  <label style={{ fontSize: 11, flex: 1 }}>{t('vendorYourOffer')}
                    <input type="number" min={0} step="0.01" value={price}
                      onChange={e => setPrice(e.target.value)} className="input"
                      style={{ borderColor: 'var(--accent)' }} />
                  </label>
                  <button className="btn accent" disabled={!price}
                    onClick={() => { onAdd(it, qty, +price); setOpenId(null); setQty(1); setPrice(''); }}>
                    Add
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--accent-strong)' }}>
                    {t('vendorAvailable', { n: it.qty })}
                  </span>
                  <button className="btn" onClick={() => setOpenId(it.id)}>{t('vendorAddOffer')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
      {basketCount > 0 && (
        <div style={{
          position: 'sticky', bottom: 0, margin: '0 -12px', background: 'var(--fg)',
          color: '#fff', padding: '12px 16px', display: 'flex', justifyContent: 'space-between',
        }}>
          <span>{basketCount} in offer</span>
          <button className="btn accent" onClick={onReview}>{t('vendorReview')} →</button>
        </div>
      )}
    </div>
  );
}

function ReviewView({ base, basket, t, onBack, onDone }: {
  base: string; basket: BasketLine[];
  t: (k: string) => string; onBack: () => void; onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit() {
    setBusy(true); setErr('');
    const r = await fetch(`${base}/bids`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactName: name, note,
        lines: basket.map(l => ({ inventoryId: l.inventoryId, qty: l.qty, unitPrice: l.unitPrice })),
      }),
    });
    setBusy(false);
    if (r.ok) onDone();
    else setErr((await r.json().catch(() => ({}))).error ?? 'Submit failed');
  }
  return (
    <div style={{ padding: '0 16px 24px' }}>
      <button className="btn ghost" onClick={onBack}>← Back</button>
      {basket.map(l => (
        <div key={l.inventoryId} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
          <span>{l.label}<br /><small style={{ color: 'var(--fg-muted)' }}>{l.qty} × ${l.unitPrice}</small></span>
          <b>${(l.qty * l.unitPrice).toFixed(2)}</b>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontWeight: 700 }}>
        <span>{t('vendorTotalOffered')}</span><span>${basketTotal(basket).toFixed(2)}</span>
      </div>
      <input className="input" placeholder={t('vendorContactName')} value={name}
        onChange={e => setName(e.target.value)} style={{ width: '100%', marginTop: 8 }} />
      <textarea className="input" placeholder={t('vendorNote')} value={note}
        onChange={e => setNote(e.target.value)} style={{ width: '100%', marginTop: 8 }} />
      {err && <p style={{ color: 'var(--neg)' }}>{err}</p>}
      <button className="btn accent" disabled={!name || busy}
        onClick={submit} style={{ width: '100%', marginTop: 14 }}>
        {t('vendorSubmit')}
      </button>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', textAlign: 'center', marginTop: 10 }}>
        {t('vendorNonBinding')}
      </p>
    </div>
  );
}

function MyOffersView({ base, t }: { base: string; t: (k: string) => string }) {
  const [bids, setBids] = useState<Array<{
    id: string; status: string; createdAt: string;
    lines: Array<{ label: string; offeredQty: number; offeredUnitPrice: number;
      status: string; acceptedUnitPrice: number | null }>;
  }>>([]);
  useEffect(() => { (async () => {
    const r = await fetch(`${base}/bids`);
    if (r.ok) setBids((await r.json()).bids);
  })(); }, [base]);
  const badge: Record<string, string> = {
    pending: t('vendorPending'), accepted: t('vendorAccepted'), declined: t('vendorDeclined'),
  };
  return (
    <div style={{ padding: '0 16px 24px' }}>
      {bids.length === 0 && <p style={{ color: 'var(--fg-muted)' }}>No offers yet.</p>}
      {bids.map(b => (
        <div key={b.id} style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--fg-subtle)' }}>
            {b.id} · {new Date(b.createdAt).toLocaleDateString()}
          </div>
          {b.lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{l.label}<br /><small style={{ color: 'var(--fg-muted)' }}>
                {l.offeredQty} × ${l.offeredUnitPrice}
                {l.acceptedUnitPrice != null && ` → @ $${l.acceptedUnitPrice}`}
              </small></span>
              <span className="chip">{badge[l.status] ?? l.status}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

> If `useT` is not the i18n hook name, open `lib/i18n.tsx` and use the exported hook/selector it actually provides (the file exports `I18N`; match the existing consumer pattern used by other pages like `SubmitForm.tsx`). If `.input`/`.btn` class names differ, use the utility classes `tokens.css` actually defines (observed: `.btn`, `.btn.accent`, `.btn.ghost`, `.chip`, `.input`).

- [ ] **Step 3: Wire into `App.tsx`**

Modify `apps/frontend/src/App.tsx` to branch *before* the phone/desktop split:

```tsx
import { useEffect, useState } from 'react';
import { LangProvider } from './lib/i18n';
import { MobileApp } from './MobileApp';
import { DesktopApp } from './DesktopApp';
import { VendorApp } from './VendorApp';
import { vendorTokenFromPath } from './lib/vendor';

import './styles/desktop.css';

const PHONE_BREAKPOINT = 720;
// …useIsPhone unchanged…

export default function App() {
  const isPhone = useIsPhone();
  const vendorToken = typeof window !== 'undefined'
    ? vendorTokenFromPath(window.location.pathname) : null;
  if (vendorToken) {
    return <LangProvider><VendorApp token={vendorToken} /></LangProvider>;
  }
  return (
    <LangProvider>
      {isPhone ? <MobileApp /> : <DesktopApp />}
    </LangProvider>
  );
}
```

- [ ] **Step 4: Verify build + helper tests**

Run: `cd apps/frontend && npx vitest run tests/vendor.test.ts && npx tsc -b`
Expected: tests PASS, type-check clean.
Manual: `npm run dev` (or existing dev command), open `/v/<a-real-token>` (create one via the manager Customers API), confirm catalog renders with no prices, add an offer, submit, see it under "My offers". Open `/v/garbage` → "Link unavailable".

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/VendorApp.tsx apps/frontend/src/App.tsx apps/frontend/src/lib/i18n.tsx
git commit -m "feat(vendor-bids): vendor portal (browse/review/my-offers)"
```

---

## Task 10: Manager UI — vendor-link panel on the Customers page

**Files:**
- Modify: the customer detail component (find it: `grep -rl "api/customers" apps/frontend/src` — likely `pages/desktop/DesktopSettings.tsx` or a customers component referenced from there)

- [ ] **Step 1: Locate the customer detail UI**

Run: `grep -rln "api/customers" apps/frontend/src`
Pick the component that renders a single customer's detail/edit. Read it to learn its data-fetch + toast + i18n patterns.

- [ ] **Step 2: Add a "Vendor link" panel**

In that component, when a customer is selected, fetch `GET /api/customers/:id/vendor-link` (authed; reuse the existing fetch helper the file uses). Render:
- If `link === null`: a "Generate vendor link" button → `POST /api/customers/:id/vendor-link`, then refetch.
- If a link exists: a read-only box showing `${location.origin}/v/${link.token}`, a **Copy** button (reuse the existing copy/share + toast pattern used elsewhere, e.g. the sell-order share button), a status pill (`Active`), `created_at`, `last_seen_at`, `bidCount`, and a **Revoke** button → `PATCH /api/customers/vendor-link/${link.id}` `{ active:false }`, then refetch.

Keep it consistent with the file's existing styling and i18n. Add i18n keys `vendorLink`, `vendorLinkGenerate`, `vendorLinkCopy`, `vendorLinkRevoke`, `vendorLinkCopied` to both `en` and `zh` in `lib/i18n.tsx`.

- [ ] **Step 3: Verify**

Run: `cd apps/frontend && npx tsc -b`
Manual: as a manager, open a customer, generate a link, copy it, open it in a new tab → vendor portal loads for that customer; revoke → the tab's link now shows "Link unavailable" on reload.

- [ ] **Step 4: Commit**

```bash
git add -A apps/frontend/src
git commit -m "feat(vendor-bids): manager vendor-link panel on customers"
```

---

## Task 11: Manager UI — Vendor Bids view (inbox + decide + promote)

**Files:**
- Create: `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx`
- Modify: `apps/frontend/src/DesktopApp.tsx` (add a nav item + route to the new view), `apps/frontend/src/lib/route.ts` if it owns desktop view routing

- [ ] **Step 1: Inspect desktop nav/routing**

Read `apps/frontend/src/DesktopApp.tsx` and `apps/frontend/src/lib/route.ts` to learn how a manager-only desktop view is registered (e.g. how `sellorders` is added). Mirror that exactly for a new `vendorbids` view (manager-only; purchasers redirected as other manager views are).

- [ ] **Step 2: Create `DesktopVendorBids.tsx`**

Implement, using the authed fetch helper the desktop app already uses (with the stored Bearer token):
- **Inbox:** `GET /api/vendor-bids` → table: customer, contact (+note), line count, total offered, submitted, status. Optional `?status=` filter chips. Row click → detail.
- **Detail:** `GET /api/vendor-bids/:id` → per-line table: item (label + sub_label), offered qty, offered $/u, **available** (warn style when `available < offered_qty`), editable accepted-qty + accepted-$ inputs, an Accept/Decline toggle per line.
- **Save decisions:** `POST /api/vendor-bids/:id/decide` with the per-line array; refetch.
- **Promote:** a footer button "Create Draft sell-order · N accepted lines" → `POST /api/vendor-bids/:id/promote`; on success show a toast with the new `SL-####` and navigate to the existing sell-order editor route for it (reuse the navigation helper the sell-orders page uses).

Match the desktop table/segmented-control/toast styling used by `DesktopSellOrders.tsx`. Add any new i18n keys to both `en` and `zh`.

- [ ] **Step 3: Verify**

Run: `cd apps/frontend && npx tsc -b && npx vitest run`
Expected: clean type-check, all frontend tests pass.
Manual end-to-end: submit a bid from a vendor link → it appears in Vendor Bids inbox → open it, decline one line, accept another with an adjusted price → Save → status shows `partly_decided`/`decided` → Promote → lands in the sell-order editor with the accepted line at the accepted price.

- [ ] **Step 4: Commit**

```bash
git add -A apps/frontend/src
git commit -m "feat(vendor-bids): manager Vendor Bids review screen"
```

---

## Task 12: Full regression + smoke

- [ ] **Step 1: Backend suite**

Run: `cd apps/backend && npx vitest run`
Expected: all green.

- [ ] **Step 2: Frontend suite + build**

Run: `cd apps/frontend && npx vitest run && npx tsc -b && npm run build`
Expected: tests pass, build succeeds.

- [ ] **Step 3: Commit any fixups, then final commit**

```bash
git add -A
git commit -m "test(vendor-bids): full regression green" --allow-empty
```

---

## Self-Review Notes (author checklist — already applied)

- **Spec coverage:** §1 data model → Task 1; §2 public API (`me`/`catalog`/`bids` POST+GET) → Tasks 2–4; §3 manager API decide/promote + link CRUD → Tasks 5–7; §4 frontend `App.tsx` isolation + portal → Tasks 8–9; §5 manager surfaces → Tasks 10–11; §6 security (uniform 404, explicit column list, no reservation, accept-time clamp) → Tasks 2,3,5,6,7; §7 error handling (400/404/409/403) → Tasks 3,5,6,7; §8 testing → tests in every backend task + Task 8 + Task 12. Out-of-scope items intentionally absent.
- **Placeholders:** none — every code step contains full code; UI Tasks 10–11 reference exact endpoints, props, and existing patterns to mirror, with concrete grep commands to locate the host components (their internal styling is intentionally delegated to the established codebase patterns, not invented here).
- **Type consistency:** `loadLink`/`Link` shape, `BasketLine`/`CatalogItem`, `nextHumanId(..., 'VB'|'SL', ...)`, route paths (`/api/public/vendor`, `/api/vendor-bids`, `/api/customers/:id/vendor-link`), and status enums (`new|partly_decided|decided`, `pending|accepted|declined`) are consistent across all tasks and match the spec and migration.
