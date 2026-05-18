# Product-grouped Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop inventory list browsable as products (one row per canonical part number) that expand to show each PO/lot underneath, without changing the underlying per-lot data model.

**Architecture:** Add a presentation/grouping layer over the existing `order_lines` (lot) model. A new shared backend helper canonicalises part numbers; a new `GET /api/inventory/products` endpoint returns scoped, filtered lines grouped by canonical part number with aggregates and embedded lots. The frontend gains a grouped⇄flat toggle; grouped view renders product rows with an expandable per-PO sub-table. All existing per-lot endpoints/workflows are untouched.

**Tech Stack:** Hono + `postgres` (porsager) on the backend, Vitest integration tests against a real Postgres seed; React + TypeScript + Vite on the frontend (no frontend unit-test infra — verified via `tsc` + `vite build`).

---

## Background the engineer needs

- **Inventory = `order_lines`.** Every PO submission (`POST /api/orders`) writes an `orders` row plus one or more `order_lines`. Each `order_line` is a **lot**: its own `unit_cost`, `sell_price`, `condition`, `health`, `status`, and effective warehouse (`COALESCE(l.warehouse_id, o.warehouse_id)`). Sell orders and transfers reference specific line IDs. **Do not merge or delete lines.**
- **Canonical part number** is how two sloppily-entered part numbers ("ABC-123", " abc-123 ", "PN: ABC-123") are recognised as the same product. The rule already exists in three places that must stay in lockstep:
  - Frontend: `apps/frontend/src/lib/format.ts` → `canonicalPartNumber()`
  - Backend SQL: `apps/backend/src/routes/inventory.ts` → inside `GET /events/by-part` (lines ~140-143)
  - Scan-time: `apps/backend/src/ai/normalize.ts`
- **Route ordering matters in Hono.** In `inventory.ts`, all static routes (`/events/all`, `/aggregate/by-part`, `/events/by-part`, `/transfer-orders`, `/transfer-orders/:id/...`) are registered **before** the param route `inventory.get('/:id', ...)` (line ~231) so they aren't swallowed by `/:id`. The new `/products` route **must** be registered before the `/:id` handler.
- **Cost-stripping rule.** Purchasers must never see cost/profit. The list handler (`inventory.get('/')`, lines ~49-58) strips `unit_cost`/`profit`/`margin` for non-managers. The new endpoint must apply the same rule to lot rows and aggregates.
- **Backend tests** run against a seeded Postgres DB. Pattern: `resetDb()` in `beforeEach`, `loginAs(ALEX)` (manager) / `loginAs(MARCUS)` (purchaser), `api('METHOD', path, { token, body })` returns `{ status, body }`. The seed already contains inventory, so tests isolate their own data with a unique search token via `?q=`.
- **Run backend tests:** `cd apps/backend && npm test` (or a single file: `npm test -- inventory-products`).
- **Frontend checks:** `cd apps/frontend && npm run typecheck && npm run build`.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `apps/backend/src/lib/part-number.ts` | Create | Single source of the canonical-part-number SQL fragments + prefix regex |
| `apps/backend/src/routes/inventory.ts` | Modify | Refactor `/events/by-part` to use the helper; add `GET /products` before `/:id` |
| `apps/backend/tests/part-number-canon.test.ts` | Create | Parity test: helper canonicalisation matches the documented cases |
| `apps/backend/tests/inventory-products.test.ts` | Create | Grouping, singletons, aggregates, scoping, cost-stripping, filter passthrough |
| `apps/frontend/src/lib/preferences.tsx` | Modify | Add `'inventory.view'` pref key |
| `apps/frontend/src/pages/desktop/InventoryProductTable.tsx` | Create | Grouped product rows + expandable per-PO lot sub-table |
| `apps/frontend/src/pages/desktop/DesktopInventory.tsx` | Modify | Grouped⇄flat toggle, products fetch, render the new table, selection wiring |

---

## Task 1: Shared canonical-part-number helper

**Files:**
- Create: `apps/backend/src/lib/part-number.ts`
- Modify: `apps/backend/src/routes/inventory.ts` (the `GET /events/by-part` handler, lines ~132-162)
- Test: `apps/backend/tests/part-number-canon.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/part-number-canon.test.ts`. This test asserts the helper produces the SAME canonical string that Postgres produces, by running the fragment against the live DB (the helper only makes sense as SQL, so we verify it through `sql`).

```ts
import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import { canonPartArg } from '../src/lib/part-number';

// Uses the test Postgres directly (same DATABASE_URL the app uses in tests).
const sql = postgres(process.env.DATABASE_URL as string, { prepare: false, max: 2 });

async function canon(raw: string): Promise<string> {
  const rows = await sql<{ c: string }[]>`SELECT ${canonPartArg(sql, raw)} AS c`;
  return rows[0].c;
}

describe('canonPartArg — canonical part-number parity', () => {
  it('collapses case / whitespace / P-N / S-N / PART prefixes to one key', async () => {
    const variants = ['ABC-123', ' abc-123 ', 'PN: ABC-123', 'p/n abc-123', 'PART NO: ABC-123', 'S/N ABC-123'];
    const canons = await Promise.all(variants.map(canon));
    for (const c of canons) expect(c).toBe('ABC-123'.toUpperCase().replace(/[\s-]/g, m => (m === '-' ? '-' : '')));
    // All variants must collapse to exactly one key.
    expect(new Set(canons).size).toBe(1);
    expect(canons[0]).toBe('ABC-123');
  });

  it('empty / whitespace-only canonicalises to empty string', async () => {
    expect(await canon('')).toBe('');
    expect(await canon('   ')).toBe('');
  });

  afterAll(async () => { await sql.end({ timeout: 5 }); });
});
```

Add the missing import at the top with the others: `import { describe, it, expect, afterAll } from 'vitest';`

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npm test -- part-number-canon`
Expected: FAIL — `Cannot find module '../src/lib/part-number'`.

- [ ] **Step 3: Write the helper**

Create `apps/backend/src/lib/part-number.ts`:

```ts
// Single source of truth for the canonical-part-number rule used to decide
// whether two PO lines describe the same product. Kept in lockstep with the
// frontend canonicalPartNumber() (frontend/src/lib/format.ts) and the
// scan-time rule in ai/normalize.ts. Strips a leading P/N | S/N | PART(NO|
// NUMBER) prefix, drops ALL whitespace, upper-cases.
//
// POSIX bracket classes ([[:space:]]) are used instead of \s so the pattern
// survives as plain SQL text inside REGEXP_REPLACE.

import postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

export const PART_PREFIX_RE =
  '^[[:space:]]*(P[[:space:]]*/?[[:space:]]*N|S[[:space:]]*/?[[:space:]]*N|PART[[:space:]]*(NO|NUMBER)?)[[:space:]]*[:#]?[[:space:]]*';

// Canonical form of a part_number COLUMN expression.
// Pass the column as a fragment, e.g. canonPartCol(sql, sql`l.part_number`).
export function canonPartCol(sql: Sql, col: ReturnType<Sql>) {
  return sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(${col}, ''), ${PART_PREFIX_RE}, '', 'i'), '[[:space:]]+', '', 'g'))`;
}

// Canonical form of a literal string argument.
export function canonPartArg(sql: Sql, raw: string) {
  return sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(${raw}, ${PART_PREFIX_RE}, '', 'i'), '[[:space:]]+', '', 'g'))`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npm test -- part-number-canon`
Expected: PASS (both `it` blocks green).

- [ ] **Step 5: Refactor `/events/by-part` to consume the helper**

In `apps/backend/src/routes/inventory.ts`, add to the imports near the top (after the `nextHumanId` import line):

```ts
import { canonPartCol, canonPartArg } from '../lib/part-number';
```

Then in the `inventory.get('/events/by-part', ...)` handler, replace these three lines (currently ~141-143):

```ts
  const PFX = '^[[:space:]]*(P[[:space:]]*/?[[:space:]]*N|S[[:space:]]*/?[[:space:]]*N|PART[[:space:]]*(NO|NUMBER)?)[[:space:]]*[:#]?[[:space:]]*';
  const canonCol = sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(l.part_number, ''), ${PFX}, '', 'i'), '[[:space:]]+', '', 'g'))`;
  const canonArg = sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(${pnRaw}, ${PFX}, '', 'i'), '[[:space:]]+', '', 'g'))`;
```

with:

```ts
  const canonCol = canonPartCol(sql, sql`l.part_number`);
  const canonArg = canonPartArg(sql, pnRaw);
```

(The `WHERE ... ${canonCol} = ${canonArg}` line below stays exactly as-is.)

- [ ] **Step 6: Run the existing events test + typecheck to verify no regression**

Run: `cd apps/backend && npm test -- inventory-events-by-part && npm run typecheck`
Expected: PASS — the existing `union across same-part-number peers` suite is still green; `tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/lib/part-number.ts apps/backend/src/routes/inventory.ts apps/backend/tests/part-number-canon.test.ts
git commit -m "refactor(inventory): extract canonical part-number into shared helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `GET /api/inventory/products` endpoint

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` (add handler **before** the `inventory.get('/:id', ...)` route at line ~231)
- Test: `apps/backend/tests/inventory-products.test.ts`

**Response contract (what Task 4 will consume):**

```ts
type ProductLot = {
  id: string;
  order_id: string;
  created_at: string;
  user_name: string;
  user_initials: string;
  unit_cost?: number;          // managers only — absent for purchasers
  sell_price: number | null;
  condition: string;
  health: number | null;
  warehouse_id: string | null;
  warehouse_short: string | null;
  qty: number;
  status: string;
};
type ProductGroup = {
  key: string;                 // canonical PN, or `line:<id>` for PN-less singletons
  part_number: string | null;  // representative raw PN (newest non-null); null when PN-less
  category: string;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  form_factor: string | null;
  description: string | null;
  rpm: number | null;
  mixed_spec: boolean;         // true if any lot's spec differs from the representative
  qty: number;                 // total across lots
  qty_in_transit: number;      // status = 'In Transit'
  qty_in_stock: number;        // status = 'Done'
  qty_reviewing: number;       // status = 'Reviewing'
  lot_count: number;           // number of lots (lines) in the group
  po_count: number;            // distinct order_id count
  unit_cost_min?: number;      // managers only
  unit_cost_max?: number;      // managers only
  unit_cost_avg?: number;      // managers only — qty-weighted
  sell_price: number | null;   // representative (newest lot's sell_price)
  warehouses: string[];        // distinct non-null warehouse_short
  created_at: string;          // newest lot created_at
  submitters: string[];        // distinct user_name
  lines: ProductLot[];         // newest-first
};
```

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/inventory-products.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Lot = { id: string; unit_cost?: number; qty: number; status: string };
type Group = {
  key: string; part_number: string | null; qty: number; lot_count: number;
  po_count: number; qty_in_transit: number; qty_in_stock: number;
  unit_cost_avg?: number; lines: Lot[];
};

// Each call = a separate PO (one order, one line) so lot_count/po_count are
// exercised. `brand` is unique per test so ?q= isolates from seed data.
async function po(token: string, opts: { brand: string; partNumber?: string; qty?: number; unitCost?: number }) {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: [{
        category: 'RAM', brand: opts.brand, capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        ...(opts.partNumber !== undefined ? { partNumber: opts.partNumber } : {}),
        condition: 'Pulled — Tested', qty: opts.qty ?? 4, unitCost: opts.unitCost ?? 80,
      }],
    },
  });
  expect(r.status).toBe(201);
}

async function products(token: string, q: string) {
  return api<{ products: Group[] }>('GET', `/api/inventory/products?q=${encodeURIComponent(q)}`, { token });
}

describe('GET /api/inventory/products', () => {
  beforeEach(async () => { await resetDb(); });

  it('groups sloppy part-number variants into ONE product, summing qty & lots', async () => {
    const { token } = await loginAs(ALEX);
    await po(token, { brand: 'GRPTESTA', partNumber: 'GRPA-1', qty: 4, unitCost: 70 });
    await po(token, { brand: 'GRPTESTA', partNumber: ' grpa-1 ', qty: 6, unitCost: 90 });
    await po(token, { brand: 'GRPTESTA', partNumber: 'PN: GRPA-1', qty: 1, unitCost: 80 });

    const r = await products(token, 'grpa-1');
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(1);
    const g = r.body.products[0];
    expect(g.qty).toBe(11);
    expect(g.lot_count).toBe(3);
    expect(g.po_count).toBe(3);
    expect(g.lines.length).toBe(3);
    // qty-weighted average cost: (4*70 + 6*90 + 1*80) / 11
    expect(g.unit_cost_avg).toBeCloseTo((4 * 70 + 6 * 90 + 1 * 80) / 11, 4);
  });

  it('treats part-number-less lines as their own singleton groups', async () => {
    const { token } = await loginAs(ALEX);
    await po(token, { brand: 'NULLBRANDX' }); // no partNumber
    await po(token, { brand: 'NULLBRANDX' }); // no partNumber — still its OWN group

    const r = await products(token, 'nullbrandx');
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(2);
    for (const g of r.body.products) {
      expect(g.part_number).toBeNull();
      expect(g.key.startsWith('line:')).toBe(true);
      expect(g.lot_count).toBe(1);
    }
  });

  it('aggregates qty by status', async () => {
    const { token } = await loginAs(ALEX);
    await po(token, { brand: 'STATX', partNumber: 'STAT-1', qty: 5 }); // default status In Transit
    const r = await products(token, 'stat-1');
    const g = r.body.products[0];
    expect(g.qty_in_transit).toBe(5);
    expect(g.qty_in_stock).toBe(0);
  });

  it('hides cost from purchasers (no unit_cost on lots, no unit_cost_avg)', async () => {
    const { token } = await loginAs(MARCUS); // purchaser
    await po(token, { brand: 'PURCOSTX', partNumber: 'PUR-1' });
    const r = await products(token, 'pur-1');
    expect(r.status).toBe(200);
    const g = r.body.products[0];
    expect(g.unit_cost_avg).toBeUndefined();
    expect(g.lines[0].unit_cost).toBeUndefined();
  });

  it('scopes purchasers to their own lines', async () => {
    const mgr = await loginAs(ALEX);
    await po(mgr.token, { brand: 'SCOPEZ', partNumber: 'SCOPE-9' });
    const buyer = await loginAs(MARCUS);
    const r = await products(buyer.token, 'scope-9');
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npm test -- inventory-products`
Expected: FAIL — all cases fail (route returns 404 / `products` undefined).

- [ ] **Step 3: Implement the `/products` handler**

In `apps/backend/src/routes/inventory.ts`, insert this handler **immediately before** the `// Single inventory line + its audit log.` comment and its `inventory.get('/:id', async (c) => {` (line ~230). It must come before `/:id` or Hono will route `/products` into the param handler.

```ts
// Product-grouped inventory (PRD §5.10 follow-up). Same scoping/filters/cost-
// stripping as the flat list, but collapses lines that share a canonical part
// number into one product row, with each PO/lot embedded. Lines with no part
// number are NOT grouped — each is its own singleton (key `line:<id>`).
//
// Grouping is done in JS over the scoped line set (ordered newest-first).
// RAW_CAP bounds memory; GROUP_CAP bounds the response — matches the flat
// list's 200-row intent applied to groups instead of lines.
inventory.get('/products', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';
  const category = c.req.query('category');
  const status = c.req.query('status');
  const search = c.req.query('q')?.toLowerCase().trim();
  const warehouse = c.req.query('warehouse');

  const RAW_CAP = 2000;
  const GROUP_CAP = 200;

  const scopeFrag    = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const categoryFrag = category ? sql`l.category = ${category}` : sql`TRUE`;
  const statusFrag   = status ? sql`l.status = ${status}` : sql`TRUE`;
  const whFrag       = warehouse ? sql`COALESCE(l.warehouse_id, o.warehouse_id) = ${warehouse}` : sql`TRUE`;
  const searchFrag   = search
    ? sql`(LOWER(COALESCE(l.brand,'')) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(l.part_number,'')) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(l.description,'')) LIKE '%' || ${search} || '%')`
    : sql`TRUE`;

  const canonCol = canonPartCol(sql, sql`l.part_number`);

  type Row = {
    id: string; order_id: string; user_id: string;
    category: string; brand: string | null; capacity: string | null;
    generation: string | null; type: string | null; classification: string | null;
    rank: string | null; speed: string | null; interface: string | null;
    form_factor: string | null; description: string | null;
    part_number: string | null; canon: string; rpm: number | null;
    condition: string; qty: number; unit_cost: number; sell_price: number | null;
    status: string; health: number | null; created_at: string;
    warehouse_id: string | null; warehouse_short: string | null;
    user_name: string; user_initials: string;
  };

  const rows = (await sql`
    SELECT l.id, l.order_id, o.user_id,
           l.category, l.brand, l.capacity, l.generation, l.type, l.classification,
           l.rank, l.speed, l.interface, l.form_factor, l.description,
           l.part_number, ${canonCol} AS canon, l.rpm,
           l.condition, l.qty, l.unit_cost::float AS unit_cost,
           l.sell_price::float AS sell_price, l.status, l.health::float AS health,
           l.created_at,
           COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id,
           w.short AS warehouse_short,
           u.name AS user_name, u.initials AS user_initials
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    JOIN users  u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag} AND ${whFrag} AND ${searchFrag}
    ORDER BY l.created_at DESC
    LIMIT ${RAW_CAP}
  `) as unknown as Row[];

  // Group key: canonical PN when present, else a per-line singleton key.
  const groups = new Map<string, Row[]>();
  const order: string[] = []; // preserves newest-first group order
  for (const r of rows) {
    const key = r.canon && r.canon.length > 0 ? r.canon : `line:${r.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else { groups.set(key, [r]); order.push(key); }
  }

  const SPEC_KEYS = ['category','brand','capacity','generation','type','classification','rank','speed','interface','form_factor','description','rpm'] as const;

  const products = order.slice(0, GROUP_CAP).map((key) => {
    const lots = groups.get(key)!;          // already newest-first
    const head = lots[0];                   // representative = newest lot
    const isSingleton = !(head.canon && head.canon.length > 0);

    let qty = 0, inTransit = 0, inStock = 0, reviewing = 0;
    let costMin = Infinity, costMax = -Infinity, costWeighted = 0;
    const whs = new Set<string>();
    const submitters = new Set<string>();
    let mixed = false;
    let repPn: string | null = null;

    for (const l of lots) {
      qty += l.qty;
      if (l.status === 'In Transit') inTransit += l.qty;
      else if (l.status === 'Done') inStock += l.qty;
      else if (l.status === 'Reviewing') reviewing += l.qty;
      costMin = Math.min(costMin, l.unit_cost);
      costMax = Math.max(costMax, l.unit_cost);
      costWeighted += l.unit_cost * l.qty;
      if (l.warehouse_short) whs.add(l.warehouse_short);
      if (l.user_name) submitters.add(l.user_name);
      if (repPn === null && l.part_number) repPn = l.part_number;
      for (const k of SPEC_KEYS) {
        if (String((l as Record<string, unknown>)[k] ?? '') !== String((head as Record<string, unknown>)[k] ?? '')) mixed = true;
      }
    }

    const base = {
      key,
      part_number: repPn,
      category: head.category, brand: head.brand, capacity: head.capacity,
      generation: head.generation, type: head.type, classification: head.classification,
      rank: head.rank, speed: head.speed, interface: head.interface,
      form_factor: head.form_factor, description: head.description, rpm: head.rpm,
      mixed_spec: isSingleton ? false : mixed,
      qty,
      qty_in_transit: inTransit, qty_in_stock: inStock, qty_reviewing: reviewing,
      lot_count: lots.length,
      po_count: new Set(lots.map((l) => l.order_id)).size,
      sell_price: head.sell_price,
      warehouses: [...whs],
      created_at: head.created_at,
      submitters: [...submitters],
      lines: lots.map((l) => ({
        id: l.id, order_id: l.order_id, created_at: l.created_at,
        user_name: l.user_name, user_initials: l.user_initials,
        sell_price: l.sell_price, condition: l.condition, health: l.health,
        warehouse_id: l.warehouse_id, warehouse_short: l.warehouse_short,
        qty: l.qty, status: l.status,
        ...(isManager ? { unit_cost: l.unit_cost } : {}),
      })),
    };

    if (!isManager) return base;
    return {
      ...base,
      unit_cost_min: costMin === Infinity ? 0 : costMin,
      unit_cost_max: costMax === -Infinity ? 0 : costMax,
      unit_cost_avg: qty > 0 ? costWeighted / qty : 0,
    };
  });

  return c.json({ products });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npm test -- inventory-products`
Expected: PASS — all five `it` blocks green.

- [ ] **Step 5: Typecheck + full backend suite (no regressions)**

Run: `cd apps/backend && npm run typecheck && npm test`
Expected: `tsc` clean; entire backend suite green (including `inventory-events-by-part`, `smoke`, `sell-orders`).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/inventory.ts apps/backend/tests/inventory-products.test.ts
git commit -m "feat(inventory): GET /products — part-number-grouped inventory

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add the `inventory.view` preference

**Files:**
- Modify: `apps/frontend/src/lib/preferences.tsx` (the `PrefMap` type, line ~26-34)

- [ ] **Step 1: Add the pref key**

In `apps/frontend/src/lib/preferences.tsx`, in the `PrefMap` type, add the `'inventory.view'` line:

```ts
export type PrefMap = {
  'language': 'en' | 'zh';
  'tweaks.density': 'comfortable' | 'compact';
  'tweaks.rolePreview': 'actual' | 'as_purchaser';
  'inventory.cols.manager': string[];
  'inventory.cols.purchaser': string[];
  'inventory.view': 'grouped' | 'flat';
  'orders.cols': string[];
};
```

(No legacy-migration entry is needed — this key has no prior localStorage form.)

- [ ] **Step 2: Typecheck**

Run: `cd apps/frontend && npm run typecheck`
Expected: PASS — `tsc --noEmit` clean.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/lib/preferences.tsx
git commit -m "feat(prefs): add inventory.view (grouped|flat) preference key

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `InventoryProductTable` component

**Files:**
- Create: `apps/frontend/src/pages/desktop/InventoryProductTable.tsx`

This component renders the grouped product rows and the expandable per-PO lot sub-table. It is presentational: data + callbacks are passed in. Quick-view and edit still operate on a specific lot `id`.

- [ ] **Step 1: Create the component**

Create `apps/frontend/src/pages/desktop/InventoryProductTable.tsx`:

```tsx
import { useState } from 'react';
import { fmtUSD, fmtUSD0, fmtDateShort } from '../../lib/format';

export type ProductLot = {
  id: string;
  order_id: string;
  created_at: string;
  user_name: string;
  user_initials: string;
  unit_cost?: number;
  sell_price: number | null;
  condition: string;
  health: number | null;
  warehouse_id: string | null;
  warehouse_short: string | null;
  qty: number;
  status: string;
};

export type ProductGroup = {
  key: string;
  part_number: string | null;
  category: string;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  form_factor: string | null;
  description: string | null;
  rpm: number | null;
  mixed_spec: boolean;
  qty: number;
  qty_in_transit: number;
  qty_in_stock: number;
  qty_reviewing: number;
  lot_count: number;
  po_count: number;
  unit_cost_min?: number;
  unit_cost_max?: number;
  unit_cost_avg?: number;
  sell_price: number | null;
  warehouses: string[];
  created_at: string;
  submitters: string[];
  lines: ProductLot[];
};

type Props = {
  groups: ProductGroup[];
  isManager: boolean;
  // Lot-level selection (sellable lots only). Keyed by lot id.
  selected: Set<string>;
  onToggleLot: (id: string) => void;
  onToggleGroup: (g: ProductGroup) => void;
  onQuickView: (lotId: string) => void;
  onEditLot: (lotId: string) => void;
};

const SELLABLE = new Set(['Reviewing', 'Done']);

function productLabel(g: ProductGroup): string {
  const bits = [g.brand, g.capacity, g.type, g.generation].filter(Boolean);
  return bits.length ? bits.join(' ') : (g.description || g.category);
}

function productSpec(g: ProductGroup): string {
  return [g.interface, g.form_factor, g.speed, g.rpm ? `${g.rpm} RPM` : null]
    .filter(Boolean).join(' · ');
}

export function InventoryProductTable({
  groups, isManager, selected, onToggleLot, onToggleGroup, onQuickView, onEditLot,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggleOpen = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <table className="inv-product-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ width: 28 }} />
          <th style={{ width: 28 }} />
          <th style={{ textAlign: 'left' }}>Product</th>
          <th style={{ textAlign: 'left' }}>Part #</th>
          <th style={{ textAlign: 'right' }}>Qty</th>
          <th style={{ textAlign: 'left' }}>Lots</th>
          <th style={{ textAlign: 'left' }}>Warehouses</th>
          {isManager && <th style={{ textAlign: 'right' }}>Cost</th>}
          <th style={{ textAlign: 'right' }}>Sell</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => {
          const isOpen = open.has(g.key);
          const sellableLots = g.lines.filter((l) => SELLABLE.has(l.status));
          const allSelected = sellableLots.length > 0 && sellableLots.every((l) => selected.has(l.id));
          return (
            <>
              <tr
                key={g.key}
                className="inv-product-row"
                style={{ cursor: 'pointer', borderTop: '1px solid var(--border, #eee)' }}
                onClick={() => toggleOpen(g.key)}
              >
                <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    aria-label="Select all sellable lots in this product"
                    checked={allSelected}
                    disabled={sellableLots.length === 0}
                    onChange={() => onToggleGroup(g)}
                  />
                </td>
                <td style={{ textAlign: 'center' }} aria-hidden>{isOpen ? '▾' : '▸'}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>
                    {productLabel(g)}
                    {g.mixed_spec && (
                      <span title="Specs vary across lots" style={{ marginLeft: 6, fontSize: 11, opacity: 0.6 }}>
                        mixed
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.65 }}>{productSpec(g)}</div>
                </td>
                <td>{g.part_number ?? <span style={{ opacity: 0.4 }}>—</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{g.qty}</strong>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>
                    {g.qty_in_stock} in stock · {g.qty_in_transit} in transit
                    {g.qty_reviewing ? ` · ${g.qty_reviewing} reviewing` : ''}
                  </div>
                </td>
                <td>{g.lot_count} lot{g.lot_count === 1 ? '' : 's'} · {g.po_count} PO{g.po_count === 1 ? '' : 's'}</td>
                <td>{g.warehouses.length ? g.warehouses.join(', ') : <span style={{ opacity: 0.4 }}>—</span>}</td>
                {isManager && (
                  <td style={{ textAlign: 'right' }}>
                    {g.unit_cost_min === g.unit_cost_max
                      ? fmtUSD(g.unit_cost_avg ?? 0)
                      : `${fmtUSD0(g.unit_cost_min ?? 0)}–${fmtUSD0(g.unit_cost_max ?? 0)}`}
                  </td>
                )}
                <td style={{ textAlign: 'right' }}>
                  {g.sell_price == null ? <span style={{ opacity: 0.4 }}>—</span> : fmtUSD(g.sell_price)}
                </td>
              </tr>

              {isOpen && (
                <tr key={`${g.key}-lots`}>
                  <td />
                  <td colSpan={isManager ? 8 : 7} style={{ padding: 0 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--subtle, #fafafa)' }}>
                      <thead>
                        <tr style={{ fontSize: 11, opacity: 0.6 }}>
                          <th style={{ width: 28 }} />
                          <th style={{ textAlign: 'left' }}>PO</th>
                          <th style={{ textAlign: 'left' }}>Date</th>
                          <th style={{ textAlign: 'left' }}>By</th>
                          {isManager && <th style={{ textAlign: 'right' }}>Cost</th>}
                          <th style={{ textAlign: 'left' }}>Condition</th>
                          <th style={{ textAlign: 'left' }}>Warehouse</th>
                          <th style={{ textAlign: 'right' }}>Qty</th>
                          <th style={{ textAlign: 'left' }}>Status</th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l) => (
                          <tr key={l.id} style={{ borderTop: '1px solid var(--border, #eee)' }}>
                            <td style={{ textAlign: 'center' }}>
                              <input
                                type="checkbox"
                                aria-label="Select lot"
                                checked={selected.has(l.id)}
                                disabled={!SELLABLE.has(l.status)}
                                onChange={() => onToggleLot(l.id)}
                              />
                            </td>
                            <td>{l.order_id}</td>
                            <td>{fmtDateShort(l.created_at)}</td>
                            <td title={l.user_name}>{l.user_initials}</td>
                            {isManager && <td style={{ textAlign: 'right' }}>{fmtUSD(l.unit_cost ?? 0)}</td>}
                            <td>
                              {l.condition}
                              {l.health != null ? ` · ${l.health}%` : ''}
                            </td>
                            <td>{l.warehouse_short ?? '—'}</td>
                            <td style={{ textAlign: 'right' }}>{l.qty}</td>
                            <td>{l.status}</td>
                            <td style={{ textAlign: 'right' }}>
                              <button type="button" title="Quick view" onClick={() => onQuickView(l.id)}>👁</button>
                              <button type="button" title="Edit" onClick={() => onEditLot(l.id)}>✎</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </>
          );
        })}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/frontend && npm run typecheck`
Expected: PASS — `tsc --noEmit` clean (component is self-contained; not yet imported anywhere).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/pages/desktop/InventoryProductTable.tsx
git commit -m "feat(inventory): InventoryProductTable — grouped rows + per-PO drilldown

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire grouped⇄flat toggle into `DesktopInventory`

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopInventory.tsx`

**Read the whole file first.** It is ~930 lines. The anchors below identify exactly where to make each change; preserve everything else (the flat table, filters, selection bar, modals).

- [ ] **Step 1: Add imports + product state**

At the top of `DesktopInventory.tsx`, in the existing import block, add:

```ts
import { InventoryProductTable } from './InventoryProductTable';
import type { ProductGroup } from './InventoryProductTable';
```

Inside the `DesktopInventory` component, next to the other `useState`/`usePreference` declarations (right after the `colsKey` block, near line ~93), add the view toggle and product state:

```ts
  const [view, setView] = usePreference('inventory.view', 'grouped');
  const [products, setProducts] = useState<ProductGroup[]>([]);
  const [productsLoaded, setProductsLoaded] = useState(false);
```

- [ ] **Step 2: Fetch products when in grouped view**

Find the existing inventory fetch effect — it builds `params` and calls
`api.get<{ items: InventoryRow[] }>(\`/api/inventory?${params}\`)` (around line ~128).
**Immediately after that effect**, add a second effect that fetches the grouped
endpoint with the same filter params, only when `view === 'grouped'`:

```ts
  useEffect(() => {
    if (view !== 'grouped') return;
    let alive = true;
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (warehouseFilter !== 'all') params.set('warehouse', warehouseFilter);
    if (search.trim()) params.set('q', search.trim());
    const h = setTimeout(() => {
      api.get<{ products: ProductGroup[] }>(`/api/inventory/products?${params}`)
        .then(r => { if (alive) { setProducts(r.products); setProductsLoaded(true); } })
        .catch(() => { if (alive) { setProducts([]); setProductsLoaded(true); } });
    }, 200);
    return () => { alive = false; clearTimeout(h); };
  }, [view, filter, statusFilter, warehouseFilter, search]);
```

> Note: match the exact param-building style already used by the flat-list
> effect in this file (same query keys: `category`, `status`, `warehouse`,
> `q`, same 200ms debounce). If the flat effect derives `params` differently,
> mirror it so both views filter identically.

- [ ] **Step 3: Add the grouped/flat toggle control**

Find where the filter controls are rendered (the category/status/warehouse
filter row, near the column-visibility menu button — search for `colsMenuOpen`
or the filter pills). Add this toggle next to the column-visibility button:

```tsx
        <div className="inv-view-toggle" role="group" aria-label="Inventory view">
          <button
            type="button"
            className={view === 'grouped' ? 'active' : ''}
            onClick={() => setView('grouped')}
          >
            Grouped
          </button>
          <button
            type="button"
            className={view === 'flat' ? 'active' : ''}
            onClick={() => setView('flat')}
          >
            Flat
          </button>
        </div>
```

- [ ] **Step 4: Render the product table in grouped view**

Find where the flat inventory `<table>` is rendered (the `<tbody>` mapping
`items` into rows, near line ~472). Wrap the existing table so it only renders
in flat view, and render `InventoryProductTable` in grouped view. The minimal,
safe change: locate the JSX element that is the flat table's outer wrapper and
conditionally branch:

```tsx
        {view === 'grouped' ? (
          <InventoryProductTable
            groups={products}
            isManager={isManager}
            selected={selected}
            onToggleLot={(id) => {
              setSelected(prev => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              });
            }}
            onToggleGroup={(g) => {
              const sellable = g.lines.filter(l => l.status === 'Reviewing' || l.status === 'Done').map(l => l.id);
              setSelected(prev => {
                const next = new Set(prev);
                const allOn = sellable.length > 0 && sellable.every(id => next.has(id));
                for (const id of sellable) { if (allOn) next.delete(id); else next.add(id); }
                return next;
              });
            }}
            onQuickView={(lotId) => {
              const lot = products.flatMap(p => p.lines).find(l => l.id === lotId);
              const row = items.find(i => i.id === lotId);
              if (row) setQuickView(row);
              else if (lot) onEditItem(lotId); // fallback if row not in flat cache
            }}
            onEditLot={(lotId) => onEditItem(lotId)}
          />
        ) : (
          /* ——— existing flat table JSX goes here, unchanged ——— */
        )}
```

> The flat branch must contain the **exact existing table JSX** that is there
> today — do not rewrite it. Only the `{view === 'grouped' ? (...) : (...)}`
> wrapper is new. `selected`, `setSelected`, `items`, `setQuickView`,
> `onEditItem` are all already defined in this component.

> QuickView currently expects an `InventoryRow` and derives peers from the
> flat `items` array (`canonicalPartNumber` filter). In grouped view `items`
> may be empty (flat list not fetched). For this pass: if the lot isn't in the
> flat `items` cache, fall back to opening the edit page (`onEditItem`), as
> shown above. A dedicated product-aware QuickView is a follow-up.

- [ ] **Step 5: Guard the empty/loading state**

Where the flat view shows its "no items / loading" placeholder (search for
`loadedOnce`), add an equivalent for grouped view so an empty product list
doesn't render a bare table. Use `productsLoaded` and `products.length`:

```tsx
        {view === 'grouped' && productsLoaded && products.length === 0 && (
          <div className="inv-empty">No products match these filters.</div>
        )}
```

Place this adjacent to the existing flat empty-state block, following the same
class/markup the file already uses for `loadedOnce && items.length === 0`.

- [ ] **Step 6: Typecheck + build**

Run: `cd apps/frontend && npm run typecheck && npm run build`
Expected: PASS — `tsc --noEmit` clean; `vite build` succeeds with no type errors.

- [ ] **Step 7: Manual smoke (document result in the commit)**

Run the stack (`docker compose up` or the dev servers), log in as a manager,
open desktop Inventory. Verify:
1. Default view is **Grouped**; one row per part number; PN-less items appear as their own rows.
2. Clicking a product row expands the per-PO lot sub-table; each lot shows PO id, cost, condition, warehouse, status.
3. Edit (✎) on a lot opens the edit page for that specific line.
4. Toggling to **Flat** shows the original per-lot table unchanged; bulk-select → create sell order / transfer still works.
5. Reloading the page preserves the chosen view (pref persists).
6. As a purchaser: no cost column in grouped view, no per-lot cost, only own lines.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopInventory.tsx
git commit -m "feat(inventory): grouped product view with per-PO drilldown + flat toggle

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:**
- Grouping layer, no schema change → Tasks 1–2 (no migration; `order_lines` untouched). ✓
- Shared canonical-PN helper kept in lockstep, reused by `/events/by-part` → Task 1. ✓
- `GET /api/inventory/products` with same filters/scoping/cost-stripping, embedded lots, group cap → Task 2. ✓
- PN-less → singleton groups → Task 2 (Step 1 test + Step 3 `line:<id>` key) + Task 4 render. ✓
- Aggregates (qty, qty-by-status, lot/PO count, cost min/max/avg mgr-only, warehouses, submitters, mixed_spec) → Task 2. ✓
- Existing endpoints untouched → only `/events/by-part` internals refactored with behavior preserved (Task 1 Step 6 regression gate). ✓
- Grouped default + flat toggle persisted like column prefs → Task 3 (pref key) + Task 5 (`usePreference`). ✓
- Expandable per-PO sub-table, edit targets specific line id → Task 4 + Task 5 Step 4. ✓
- Lot-level selection; group header selects sellable lots → Task 4 props + Task 5 `onToggleGroup`. ✓
- Purchaser cost-stripping on aggregates + lots → Task 2 Step 3 (`isManager` branch) + test. ✓
- Out of scope (phone, dashboard, submit) → not in any task. ✓

**Placeholder scan:** The only intentional "fill from existing code" point is Task 5 Step 4's flat-branch (`existing flat table JSX goes here, unchanged`) — this is deliberate: the plan must not rewrite ~450 lines of working table JSX, and the engineer is explicitly told to read the file and preserve it verbatim. No TBD/TODO/"add error handling" placeholders elsewhere.

**Type consistency:** `ProductGroup`/`ProductLot` defined in Task 4 are the contract Task 2 produces and Task 5 consumes — field names match the Task 2 response builder exactly (`qty_in_transit`, `unit_cost_avg`, `mixed_spec`, `lines[]`, `key`, `part_number`). Pref key `'inventory.view'` defined in Task 3, consumed in Task 5. Helper names `canonPartCol`/`canonPartArg` defined in Task 1, used in Tasks 1 & 2.
