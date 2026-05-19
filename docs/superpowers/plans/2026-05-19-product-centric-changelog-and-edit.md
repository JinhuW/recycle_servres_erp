# Product-Centric Changelog & Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inventory product view product-centric — a Product Detail drawer with the per-part-number changelog as its centerpiece (PO chip + qty per entry), plus a manager-only product-scoped spec/sell-price edit that propagates across every lot.

**Architecture:** Reuse the existing canonical part-number machinery (`canonPartCol`/`canonPartArg`, `/api/inventory/products`, `/api/inventory/events/by-part`). Add two backend changes (augment `by-part`; new `PATCH /api/inventory/product`) with no DB migration. Replace the Quick View modal with a Product Detail drawer; rewire the edit page so managers save product-wide. Per-lot event rows for a product edit share one transaction timestamp so the UI collapses them into one entry.

**Tech Stack:** Hono + `postgres` (apps/backend), React + Vite (apps/frontend), Vitest for both.

**Reference spec:** `docs/superpowers/specs/2026-05-19-product-centric-changelog-and-edit-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/src/routes/inventory.ts` | `by-part` query (add `order_id`,`qty`); new `PATCH /product` | Modify |
| `apps/backend/tests/inventory-events-by-part.test.ts` | assert `order_id`+`qty` in events | Modify |
| `apps/backend/tests/inventory-product-edit.test.ts` | product-edit behavior/permissions | Create |
| `apps/frontend/src/lib/changelog.ts` | `collapseProductEvents` pure fn + types | Create |
| `apps/frontend/tests/changelog.test.ts` | unit tests for collapse | Create |
| `apps/frontend/src/pages/desktop/ProductDetailDrawer.tsx` | the new drawer (replaces Quick View) | Create |
| `apps/frontend/src/pages/desktop/DesktopInventory.tsx` | swap Quick View → drawer; delete old modal | Modify |
| `apps/frontend/src/pages/desktop/DesktopInventoryEdit.tsx` | manager save = product-wide + per-lot split | Modify |

**Route-ordering caveat (critical):** Hono matches routes in registration order. `inventory.patch('/:id', …)` is defined at `inventory.ts:440` and would swallow `PATCH /product`. The new `inventory.patch('/product', …)` MUST be registered *before* line 440.

**Commands** (run from repo root):
- Backend tests: `cd apps/backend && npx vitest run <file>`
- Frontend tests: `cd apps/frontend && npx vitest run <file>`
- Backend typecheck: `cd apps/backend && npx tsc -b`
- Frontend typecheck: `cd apps/frontend && npx tsc -b`

---

## Task 1: Augment `/events/by-part` with `order_id` + `qty`

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts:144-160`
- Test: `apps/backend/tests/inventory-events-by-part.test.ts`

- [ ] **Step 1: Add a failing test**

Append this `it` block inside the existing `describe('GET /api/inventory/events/by-part …')` in `apps/backend/tests/inventory-events-by-part.test.ts`:

```ts
  it('returns source order_id and line qty on every event', async () => {
    const { token } = await loginAs(ALEX);
    const line = await createPoLine(token, 'OQ-1');
    await api('PATCH', `/api/inventory/${line}`, {
      token, body: { condition: 'Pulled — Untested' },
    });

    const r = await api<{ events: Array<{ line_id: string; order_id: string; qty: number }> }>(
      'GET', '/api/inventory/events/by-part?partNumber=OQ-1', { token });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    for (const e of r.body.events) {
      expect(typeof e.order_id).toBe('string');
      expect(e.order_id.length).toBeGreaterThan(0);
      expect(typeof e.qty).toBe('number');
      expect(e.qty).toBe(4); // createPoLine uses qty: 4
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/inventory-events-by-part.test.ts -t "returns source order_id"`
Expected: FAIL — `e.order_id` is `undefined` (`expected "undefined" to be "string"`).

- [ ] **Step 3: Add the two columns to the query**

In `apps/backend/src/routes/inventory.ts`, in the `inventory.get('/events/by-part', …)` handler, change the SELECT list (currently lines 145-149) to add `o.id AS order_id` and `l.qty`:

```ts
  const rows = await sql`
    SELECT
      e.id, e.kind, e.detail, e.created_at,
      l.id AS line_id, l.qty, l.category, l.brand, l.capacity, l.generation, l.type,
      l.interface, l.description, l.part_number, l.rpm,
      o.id AS order_id,
      act.name AS actor_name, act.initials AS actor_initials
    FROM inventory_events e
    JOIN order_lines l ON l.id = e.order_line_id
    JOIN orders o      ON o.id = l.order_id
    LEFT JOIN users act ON act.id = e.actor_id
    WHERE ${scopeFrag}
      AND l.part_number IS NOT NULL
      AND ${canonCol} = ${canonArg}
    ORDER BY e.created_at DESC
    LIMIT 200
  `;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/inventory-events-by-part.test.ts`
Expected: PASS (all tests in file, including the existing three).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/inventory.ts apps/backend/tests/inventory-events-by-part.test.ts
git commit -m "feat(inventory): expose source order_id + qty on by-part changelog"
```

---

## Task 2: `PATCH /api/inventory/product` — happy path (manager, product-wide)

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` (register a new handler *before* line 440 `inventory.patch('/:id', …)`)
- Test: `apps/backend/tests/inventory-product-edit.test.ts` (create)

The endpoint updates the documented spec fields + `sell_price` on every lot sharing the canonical part number, leaves `qty`/`unit_cost`/`status` untouched, and writes one `inventory_events` row per affected lot per changed field, all with one shared `created_at` so the UI can collapse them.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/inventory-product-edit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Line = {
  id: string; part_number: string | null; qty: number;
  unit_cost: number; sell_price: number | null; status: string; brand: string | null;
};

async function createPoLine(token: string, partNumber: string, brand = 'Samsung'): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: [{
        category: 'RAM', brand, capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        partNumber, condition: 'Pulled — Tested', qty: 4, unitCost: 78.5,
      }],
    },
  });
  expect(r.status).toBe(201);
  const list = await api<{ items: Line[] }>('GET', '/api/inventory', { token });
  return list.body.items[0].id;
}

async function getLine(token: string, id: string): Promise<Line> {
  const r = await api<{ item: Line }>('GET', `/api/inventory/${id}`, { token });
  expect(r.status).toBe(200);
  return r.body.item;
}

describe('PATCH /api/inventory/product — product-wide spec/sell-price edit', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager edit propagates specs + sell_price to every lot, leaves qty/unit_cost/status', async () => {
    const { token } = await loginAs(ALEX); // ALEX is a manager
    const lineA = await createPoLine(token, 'PWE-1');
    const lineB = await createPoLine(token, ' pwe-1 '); // canonical peer

    const r = await api('PATCH', '/api/inventory/product', {
      token, body: { partNumber: 'PWE-1', brand: 'Hynix', sellPrice: 120 },
    });
    expect(r.status).toBe(200);

    for (const id of [lineA, lineB]) {
      const ln = await getLine(token, id);
      expect(ln.brand).toBe('Hynix');
      expect(ln.sell_price).toBe(120);
      expect(ln.qty).toBe(4);          // untouched
      expect(ln.unit_cost).toBe(78.5); // untouched
      expect(ln.status).toBe('In Transit'); // untouched
    }
  });

  it('writes one event per affected lot per changed field, sharing a timestamp', async () => {
    const { token } = await loginAs(ALEX);
    const lineA = await createPoLine(token, 'PWE-2');
    const lineB = await createPoLine(token, 'PWE-2');

    const r = await api('PATCH', '/api/inventory/product', {
      token, body: { partNumber: 'PWE-2', sellPrice: 99 },
    });
    expect(r.status).toBe(200);

    const ev = await api<{ events: Array<{ line_id: string; kind: string; created_at: string }> }>(
      'GET', '/api/inventory/events/by-part?partNumber=PWE-2', { token });
    const priced = ev.body.events.filter(e => e.kind === 'priced');
    expect(new Set(priced.map(e => e.line_id))).toEqual(new Set([lineA, lineB]));
    // Same transaction timestamp → identical created_at across the lots.
    expect(new Set(priced.map(e => e.created_at)).size).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/inventory-product-edit.test.ts -t "manager edit propagates"`
Expected: FAIL — `r.status` is `404` (route falls through to `/:id` or no match), not `200`.

- [ ] **Step 3: Implement the endpoint**

In `apps/backend/src/routes/inventory.ts`, insert this handler **immediately before** the `inventory.patch('/:id', async (c) => {` line (currently line 440). `canonPartCol`/`canonPartArg` are already imported in this file.

```ts
// Product-scoped edit (manager-only). Updates identity/spec fields + sell_price
// on EVERY lot sharing the canonical part number; qty/unit_cost/status are
// per-PO-lot and never touched here. One inventory_events row per affected lot
// per changed field, all stamped with a single transaction timestamp so the
// product changelog can collapse them into one entry.
//
// Registered before patch('/:id') on purpose — Hono matches in registration
// order and '/:id' would otherwise capture '/product'.
inventory.patch('/product', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as
    | {
        partNumber?: string;
        category?: string; brand?: string; capacity?: string;
        generation?: string; type?: string; speed?: string;
        interface?: string; formFactor?: string; description?: string;
        sellPrice?: number | null;
      }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const pnRaw = body.partNumber;
  if (!pnRaw || !pnRaw.trim()) return c.json({ error: 'partNumber is required' }, 400);

  const sql = getDb(c.env);
  const canonCol = canonPartCol(sql, sql`part_number`);
  const canonArg = canonPartArg(sql, pnRaw);

  const lines = await sql<{ id: string }[]>`
    SELECT id FROM order_lines
    WHERE part_number IS NOT NULL AND ${canonCol} = ${canonArg}
  `;
  if (lines.length === 0) return c.json({ error: 'no lots for that part number' }, 404);

  // Maps a request key -> { column, newValue } for every provided field.
  const specMap: Record<string, string> = {
    partNumber: 'part_number', category: 'category', brand: 'brand',
    capacity: 'capacity', generation: 'generation', type: 'type',
    speed: 'speed', interface: 'interface', formFactor: 'form_factor',
    description: 'description',
  };
  const changes: { col: string; key: string; val: string | null }[] = [];
  for (const [key, col] of Object.entries(specMap)) {
    const v = (body as Record<string, unknown>)[key];
    if (v === undefined) continue;
    changes.push({ col, key, val: v == null ? null : String(v) });
  }
  const priceProvided = body.sellPrice !== undefined;

  if (changes.length === 0 && !priceProvided) {
    return c.json({ error: 'nothing to update' }, 400);
  }

  const ts = new Date(); // shared timestamp → collapsible in the changelog

  await sql.begin(async (tx) => {
    for (const ln of lines) {
      const before = (await tx`SELECT * FROM order_lines WHERE id = ${ln.id} LIMIT 1`)[0];

      // Apply spec columns (only the provided ones) + sell_price.
      for (const ch of changes) {
        await tx`UPDATE order_lines SET ${tx(ch.col)} = ${ch.val} WHERE id = ${ln.id}`;
      }
      if (priceProvided) {
        await tx`UPDATE order_lines SET sell_price = ${body.sellPrice ?? null} WHERE id = ${ln.id}`;
      }

      // One event per actually-changed field.
      for (const ch of changes) {
        const oldVal = before[ch.col];
        if (String(oldVal ?? '') === String(ch.val ?? '')) continue;
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail, created_at)
          VALUES (${ln.id}, ${u.id}, 'edited',
                  ${tx.json({ field: ch.key, from: oldVal == null ? null : String(oldVal), to: ch.val })},
                  ${ts})
        `;
      }
      if (priceProvided) {
        const oldPrice = before.sell_price;
        const newPrice = body.sellPrice ?? null;
        if (String(oldPrice ?? '') !== String(newPrice ?? '')) {
          await tx`
            INSERT INTO inventory_events (order_line_id, actor_id, kind, detail, created_at)
            VALUES (${ln.id}, ${u.id}, 'priced',
                    ${tx.json({ field: 'sellPrice',
                                from: oldPrice == null ? null : String(oldPrice),
                                to: newPrice == null ? null : String(newPrice) })},
                    ${ts})
          `;
        }
      }
    }
  });

  return c.json({ ok: true, lots: lines.length });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/inventory-product-edit.test.ts`
Expected: PASS (both `it` blocks).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/backend && npx tsc -b && cd ../..
git add apps/backend/src/routes/inventory.ts apps/backend/tests/inventory-product-edit.test.ts
git commit -m "feat(inventory): manager-only product-scoped spec/sell-price edit"
```

---

## Task 3: `PATCH /api/inventory/product` — permissions & edge cases

**Files:**
- Modify: `apps/backend/tests/inventory-product-edit.test.ts` (add cases)
- Modify: `apps/backend/src/routes/inventory.ts` (only if a case fails)

The guards (403/400/404, part-number re-group) are already implemented in Task 2. This task proves them and a part-number-change re-group.

- [ ] **Step 1: Add failing/locking tests**

Append inside the `describe` in `apps/backend/tests/inventory-product-edit.test.ts`:

```ts
  it('rejects a purchaser with 403', async () => {
    const mgr = await loginAs(ALEX);
    await createPoLine(mgr.token, 'PWE-3');
    const buyer = await loginAs(MARCUS); // MARCUS is a purchaser
    const r = await api('PATCH', '/api/inventory/product', {
      token: buyer.token, body: { partNumber: 'PWE-3', sellPrice: 50 },
    });
    expect(r.status).toBe(403);
  });

  it('400 when partNumber missing', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/inventory/product', { token, body: { sellPrice: 50 } });
    expect(r.status).toBe(400);
  });

  it('404 when no lot matches the part number', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/inventory/product', {
      token, body: { partNumber: 'NOPE-999', sellPrice: 50 },
    });
    expect(r.status).toBe(404);
  });

  it('changing part_number re-stamps all lots so they still group together', async () => {
    const { token } = await loginAs(ALEX);
    const lineA = await createPoLine(token, 'OLD-PN');
    const lineB = await createPoLine(token, 'OLD-PN');

    const r = await api('PATCH', '/api/inventory/product', {
      token, body: { partNumber: 'OLD-PN', /* set new */ } as Record<string, unknown>,
    });
    // Re-stamp: send the new value via a second field key the endpoint accepts.
    // partNumber is BOTH the lookup key and a settable column, so to rename we
    // look up by OLD-PN and write the new one explicitly:
    const r2 = await api('PATCH', '/api/inventory/product', {
      token, body: { partNumber: 'OLD-PN', /* lookup */ },
    });
    expect(r.status).toBe(200);
    expect(r2.status).toBe(200);

    // After a rename to NEW-PN, by-part?NEW-PN must union both lots.
    const ren = await api('PATCH', '/api/inventory/product', {
      token, body: { partNumber: 'OLD-PN' },
    });
    expect(ren.status).toBe(200);
    const ev = await api<{ events: Array<{ line_id: string }> }>(
      'GET', '/api/inventory/events/by-part?partNumber=OLD-PN', { token });
    expect(new Set(ev.body.events.map(e => e.line_id))).toEqual(new Set([lineA, lineB]));
  });
```

> Note: the rename test as written only verifies lookup-by-old-PN unions both lots. A true rename (lookup OLD-PN, write NEW-PN) is intentionally NOT expressible with a single `partNumber` field acting as both lookup and target. **Before running, replace the rename test body with the version below**, which adds a distinct lookup vs. target by extending the endpoint contract minimally:

```ts
  it('changing part_number re-stamps all lots so they still group together', async () => {
    const { token } = await loginAs(ALEX);
    const lineA = await createPoLine(token, 'OLD-PN');
    const lineB = await createPoLine(token, 'OLD-PN');

    const r = await api('PATCH', '/api/inventory/product', {
      token, body: { partNumber: 'OLD-PN', newPartNumber: 'NEW-PN' },
    });
    expect(r.status).toBe(200);

    const evNew = await api<{ events: Array<{ line_id: string }> }>(
      'GET', '/api/inventory/events/by-part?partNumber=NEW-PN', { token });
    expect(new Set(evNew.body.events.map(e => e.line_id))).toEqual(new Set([lineA, lineB]));

    const lnA = await getLine(token, lineA);
    expect(lnA.part_number).toBe('NEW-PN');
  });
```

- [ ] **Step 2: Run tests to see which fail**

Run: `cd apps/backend && npx vitest run tests/inventory-product-edit.test.ts`
Expected: 403/400/404 PASS (already implemented in Task 2). The rename test FAILS — endpoint has no `newPartNumber` (lookup vs. target) concept yet.

- [ ] **Step 3: Add `newPartNumber` (lookup key stays `partNumber`, target rename is explicit)**

In the `inventory.patch('/product', …)` body type add `newPartNumber?: string;`. Then, just after building `changes`, append a part_number rename when requested:

```ts
  if (body.newPartNumber !== undefined && body.newPartNumber !== null) {
    changes.push({ col: 'part_number', key: 'partNumber', val: String(body.newPartNumber) });
  }
```

Leave the rest unchanged: lookup is still by canonical `partNumber`; the `part_number` column is rewritten on every matched lot inside the same transaction, so they remain one canonical group.

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd apps/backend && npx vitest run tests/inventory-product-edit.test.ts`
Expected: PASS (all six `it` blocks).

- [ ] **Step 5: Full backend suite + commit**

Run: `cd apps/backend && npx vitest run`
Expected: PASS (no regressions).

```bash
git add apps/backend/src/routes/inventory.ts apps/backend/tests/inventory-product-edit.test.ts
git commit -m "feat(inventory): product-edit guards + explicit part-number rename"
```

---

## Task 4: Changelog collapse — pure function + unit tests

**Files:**
- Create: `apps/frontend/src/lib/changelog.ts`
- Test: `apps/frontend/tests/changelog.test.ts`

Pure, framework-free logic so it is unit-testable (the repo has no component test harness; FE tests live in `apps/frontend/tests/*.test.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/tests/changelog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { collapseProductEvents, type ProductEvent } from '../src/lib/changelog';

const base = (over: Partial<ProductEvent>): ProductEvent => ({
  id: Math.random().toString(36),
  kind: 'priced',
  detail: { field: 'sellPrice', from: '50', to: '75' },
  created_at: '2026-05-19T10:00:00.000Z',
  line_id: 'L1',
  order_id: 'PO-1',
  qty: 4,
  actor_name: 'Alex',
  ...over,
});

describe('collapseProductEvents', () => {
  it('merges same kind+detail+actor+timestamp across lots into one row', () => {
    const out = collapseProductEvents([
      base({ id: 'a', line_id: 'L1', order_id: 'PO-1' }),
      base({ id: 'b', line_id: 'L2', order_id: 'PO-2' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].lots).toBe(2);
    expect(out[0].orderIds.sort()).toEqual(['PO-1', 'PO-2']);
  });

  it('keeps distinct events separate', () => {
    const out = collapseProductEvents([
      base({ id: 'a', kind: 'priced' }),
      base({ id: 'b', kind: 'status', detail: { field: 'status', from: 'Draft', to: 'Done' } }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('does not merge same kind at different timestamps', () => {
    const out = collapseProductEvents([
      base({ id: 'a', created_at: '2026-05-19T10:00:00.000Z' }),
      base({ id: 'b', created_at: '2026-05-19T11:00:00.000Z' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('preserves newest-first order of the first occurrence', () => {
    const out = collapseProductEvents([
      base({ id: 'new', created_at: '2026-05-19T12:00:00.000Z', kind: 'status',
             detail: { field: 'status', from: 'a', to: 'b' } }),
      base({ id: 'old', created_at: '2026-05-19T09:00:00.000Z' }),
    ]);
    expect(out[0].id).toBe('new');
    expect(out[1].id).toBe('old');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && npx vitest run tests/changelog.test.ts`
Expected: FAIL — cannot resolve `../src/lib/changelog`.

- [ ] **Step 3: Implement the module**

Create `apps/frontend/src/lib/changelog.ts`:

```ts
// One row of GET /api/inventory/events/by-part (after Task 1 adds order_id+qty).
export type ProductEvent = {
  id: string;
  kind: string;
  detail: Record<string, unknown>;
  created_at: string;
  line_id: string;
  order_id: string;
  qty: number;
  actor_name: string | null;
};

export type CollapsedEvent = ProductEvent & {
  lots: number;        // how many per-lot rows were merged
  orderIds: string[];  // distinct source POs in this collapsed row
};

// A product-wide edit writes one identical event per lot, all sharing a
// transaction timestamp. Collapse rows that match on
// kind + detail + actor + created_at into a single entry; everything else
// passes through 1:1. Input is assumed newest-first (backend ORDER BY DESC);
// first occurrence wins position.
export function collapseProductEvents(events: ProductEvent[]): CollapsedEvent[] {
  const out: CollapsedEvent[] = [];
  const byKey = new Map<string, CollapsedEvent>();
  for (const e of events) {
    const key = [
      e.kind,
      JSON.stringify(e.detail ?? {}),
      e.actor_name ?? '',
      e.created_at,
    ].join('|');
    const existing = byKey.get(key);
    if (existing) {
      existing.lots += 1;
      if (!existing.orderIds.includes(e.order_id)) existing.orderIds.push(e.order_id);
      continue;
    }
    const row: CollapsedEvent = { ...e, lots: 1, orderIds: [e.order_id] };
    byKey.set(key, row);
    out.push(row);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/frontend && npx vitest run tests/changelog.test.ts`
Expected: PASS (4 `it` blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/changelog.ts apps/frontend/tests/changelog.test.ts
git commit -m "feat(inventory): collapse product-wide changelog events"
```

---

## Task 5: Product Detail drawer (replaces Quick View)

**Files:**
- Create: `apps/frontend/src/pages/desktop/ProductDetailDrawer.tsx`
- Modify: `apps/frontend/src/pages/desktop/DesktopInventory.tsx` (swap usage at lines 844-854; delete `InventoryQuickView`, `QvEvent`, `QV_KIND_ICON`, `summarizeQvEvent`, and now-unused imports)

The drawer keeps Quick View's header / stock summary / key-facts but makes the changelog the centerpiece: each entry shows a clickable PO chip + qty, and product-wide edits collapse into one row. Navigation reuses `navigate` from `../../lib/route` (same as `DesktopApp.tsx`).

- [ ] **Step 1: Create the drawer component**

Create `apps/frontend/src/pages/desktop/ProductDetailDrawer.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { api } from '../../lib/api';
import { navigate } from '../../lib/route';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { fmtUSD, fmtDateShort, relTime, canonicalPartNumber } from '../../lib/format';
import { collapseProductEvents, type ProductEvent, type CollapsedEvent } from '../../lib/changelog';
import type { InventoryRow } from '../../lib/types';

const KIND_ICON: Record<string, IconName> = {
  created: 'plus', edited: 'edit', status: 'flag', priced: 'tag',
  transferred: 'truck', received: 'warehouse', reopened: 'history', sold: 'tag',
};

function summarize(e: CollapsedEvent): string {
  const d = e.detail as Record<string, unknown>;
  const to = d.to == null ? '' : String(d.to);
  const from = d.from == null ? '' : String(d.from);
  const field = d.field == null ? '' : String(d.field);
  const wh = d.warehouse == null ? '' : String(d.warehouse);
  switch (e.kind) {
    case 'created':     return `Added ${e.qty} units`;
    case 'sold':        return `Sold ${e.qty}`;
    case 'transferred': return `Transferred ${e.qty}${wh ? ` → ${wh}` : ''}`;
    case 'status':      return `Status → ${to}`;
    case 'priced':      return `Sell price → ${to ? fmtUSD(Number(to)) : '—'}`;
    case 'edited':      return `${field}: ${from || '—'} → ${to || '—'}`;
    case 'received':    return `Received${wh ? ` at ${wh}` : ''}`;
    case 'reopened':    return 'Transfer re-opened';
    default:            return e.kind;
  }
}

export function ProductDetailDrawer({
  item, peers, onClose, onEdit,
}: {
  item: InventoryRow;
  peers: InventoryRow[];
  onClose: () => void;
  onEdit: () => void;
}) {
  useEscapeKey(onClose);

  const [log, setLog] = useState<CollapsedEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    const pn = item.part_number;
    if (!pn) { setLog([]); return; }
    api.get<{ events: ProductEvent[] }>(
      `/api/inventory/events/by-part?partNumber=${encodeURIComponent(pn)}`)
      .then(r => { if (alive) setLog(collapseProductEvents(r.events)); })
      .catch(() => { if (alive) setLog([]); });
    return () => { alive = false; };
  }, [item.part_number]);

  const title =
    item.category === 'RAM' ? `${item.brand ?? ''} ${item.capacity ?? ''} ${item.generation ?? ''}`.trim()
    : item.category === 'SSD' ? `${item.brand ?? ''} ${item.capacity ?? ''}`.trim()
    : item.category === 'HDD' ? `${item.brand ?? ''} ${item.capacity ?? ''}`.trim()
    : (item.description ?? item.part_number ?? '—');

  const agg = peers.reduce((acc, p) => {
    if (p.status === 'In Transit') acc.inTransit += p.qty;
    else if (p.status === 'Reviewing' || p.status === 'Done') acc.inStock += p.qty;
    return acc;
  }, { inTransit: 0, inStock: 0 });
  const poCount = new Set(peers.map(p => p.order_id)).size;
  const catIcon = item.category === 'RAM' ? 'chip'
    : (item.category === 'SSD' || item.category === 'HDD') ? 'drive' : 'box';

  const goToPO = (orderId: string) => { onClose(); navigate('/purchase-orders/' + orderId); };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.42)',
      display: 'flex', justifyContent: 'flex-end', zIndex: 80,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-elev)', borderLeft: '1px solid var(--border)',
        width: 'min(560px, 100%)', height: '100%', display: 'flex',
        flexDirection: 'column', boxShadow: '-24px 0 60px rgba(15,23,42,0.18)',
      }}>
        {/* Header */}
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent-strong)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Icon name={catIcon} size={20} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span className={'chip ' + (item.category === 'RAM' ? 'info' : item.category === 'SSD' ? 'pos' : item.category === 'HDD' ? 'cool' : 'warn')} style={{ fontSize: 10.5 }}>{item.category}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{item.part_number ?? '—'}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {agg.inTransit} in transit · {agg.inStock} in stock · {poCount} PO{poCount === 1 ? '' : 's'}
            </div>
          </div>
          <button className="btn icon sm" onClick={onClose} title="Close"><Icon name="x" size={12} /></button>
        </div>

        {/* Changelog centerpiece */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, marginBottom: 10 }}>
            Changelog · across part number
          </div>
          {log == null && <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Loading…</div>}
          {log != null && log.length === 0 && <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>No changes logged yet.</div>}
          {log != null && log.map((e, i) => (
            <div key={e.id} style={{ display: 'flex', gap: 10, padding: '11px 0', borderBottom: i < log.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--bg-soft)', color: 'var(--fg-muted)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <Icon name={KIND_ICON[e.kind] ?? 'info'} size={12} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{summarize(e)}</span>
                  {e.lots > 1 ? (
                    <span className="chip" style={{ fontSize: 10.5 }}>applied to {e.lots} lots</span>
                  ) : (
                    <button
                      onClick={() => goToPO(e.order_id)}
                      className="chip"
                      style={{ fontSize: 10.5, cursor: 'pointer', border: 'none' }}
                      title="Open purchase order"
                    >
                      {e.order_id}
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                  {e.actor_name ?? 'system'} · {relTime(e.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn accent" onClick={onEdit}><Icon name="edit" size={13} /> Edit product</button>
        </div>
      </div>
    </div>
  );
}
```

> If any import path differs (e.g. `useEscapeKey` location, `IconName` export, `InventoryRow` shape, whether `InventoryRow` has `order_id`), check the existing `DesktopInventory.tsx` imports/usages (lines 1-60) and the old `InventoryQuickView` (was lines 862-1070) and adjust the import lines to match — do not invent new exports. `InventoryRow.order_id` is referenced in `DesktopInventory.tsx:48`.

- [ ] **Step 2: Swap usage and delete the old modal in DesktopInventory.tsx**

Replace the `{quickView && ( <InventoryQuickView … /> )}` block (lines 844-854) with `ProductDetailDrawer`:

```tsx
      {quickView && (
        <ProductDetailDrawer
          item={quickView}
          peers={(() => {
            const key = canonicalPartNumber(quickView.part_number);
            return key ? items.filter(p => canonicalPartNumber(p.part_number) === key) : [quickView];
          })()}
          onClose={() => setQuickView(null)}
          onEdit={() => { onEditItem(quickView.id); setQuickView(null); }}
        />
      )}
```

Add `import { ProductDetailDrawer } from './ProductDetailDrawer';` near the other page imports. Then delete the now-dead `function InventoryQuickView(...)`, `type QvEvent`, `const QV_KIND_ICON`, `function summarizeQvEvent(...)`, and `function QVCell(...)` if it is only used by the old modal. Remove imports that become unused.

- [ ] **Step 3: Typecheck**

Run: `cd apps/frontend && npx tsc -b`
Expected: no errors. Fix any unused-import / missing-export errors by aligning to existing modules (do not add new exports to shared libs beyond `changelog.ts`).

- [ ] **Step 4: Manual browser verification**

Run the stack (`cd apps/backend && npm run dev` in one shell; `cd apps/frontend && npm run dev` in another), log in as a manager, go to Inventory:
- Open Quick view from BOTH the flat table and the grouped product table → the right-side Product Detail drawer opens.
- Changelog renders newest-first with a PO chip + qty per single-lot entry.
- Click a PO chip → navigates to `/purchase-orders/<id>`.
- A product-wide edit (do Task 6 first, or hand-run a `PATCH /api/inventory/product`) shows as one "applied to N lots" row, not N rows.
- Esc and the Close button dismiss the drawer.

Record what you saw (pass/fail per bullet). If you cannot run a browser, state that explicitly instead of claiming success.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/ProductDetailDrawer.tsx apps/frontend/src/pages/desktop/DesktopInventory.tsx
git commit -m "feat(inventory): product detail drawer with changelog centerpiece"
```

---

## Task 6: Manager save = product-wide (DesktopInventoryEdit.tsx)

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopInventoryEdit.tsx:236-253` (the `save` fn) + add `useAuth` import

The edit form's draft exposes only `partNumber` + `sellPrice` among product-wide fields; `condition`/`qty`/`unitCost`/`status`/`health`/`rpm` are per-lot. So a manager save makes two calls: product-wide for `partNumber`/`sellPrice`, per-lot for the rest. Purchasers keep today's single per-line PATCH (they cannot change sellPrice/status server-side anyway).

- [ ] **Step 1: Add the auth import**

At the top of `DesktopInventoryEdit.tsx`, add:

```tsx
import { useAuth } from '../../lib/auth';
```

- [ ] **Step 2: Read role in the component**

Inside the component (near `const { t } = useT();`, line 110), add:

```tsx
  const { user } = useAuth();
  const isManager = user.role === 'manager';
```

> Confirm `useAuth()` returns `{ user: { role } }` — check `apps/frontend/src/lib/auth.tsx` (the `useAuth` export, ~line 137) and match the destructure to its actual shape.

- [ ] **Step 3: Split the save**

Replace the `save` function (lines 236-253) with:

```tsx
  const save = async () => {
    setSaving(true);
    try {
      if (isManager) {
        // Product-wide: part number + sell price propagate to every lot.
        await api.patch('/api/inventory/product', {
          partNumber: (initialRef.current && JSON.parse(initialRef.current).partNumber) || item.part_number || undefined,
          newPartNumber: draft.partNumber || null,
          sellPrice: draft.sellPrice === '' ? null : Number(draft.sellPrice),
        });
        // Per-lot: this lot's own quantity/cost/status/condition/health/rpm.
        await api.patch(`/api/inventory/${itemId}`, {
          status: draft.status,
          unitCost: Number(draft.unitCost) || 0,
          qty: Number(draft.qty) || 0,
          condition: draft.condition,
          health: draft.health === '' ? null : Number(draft.health),
          rpm: draft.rpm === '' ? null : Number(draft.rpm),
        });
      } else {
        // Purchaser: unchanged single per-line edit on their own lot.
        await api.patch(`/api/inventory/${itemId}`, {
          status: draft.status,
          sellPrice: draft.sellPrice === '' ? null : Number(draft.sellPrice),
          unitCost: Number(draft.unitCost) || 0,
          qty: Number(draft.qty) || 0,
          condition: draft.condition,
          partNumber: draft.partNumber || null,
          health: draft.health === '' ? null : Number(draft.health),
          rpm: draft.rpm === '' ? null : Number(draft.rpm),
        });
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };
```

> `initialRef.current` holds the JSON of the draft as first loaded (set at line 141), so `JSON.parse(initialRef.current).partNumber` is the *original* part number — the lookup key — while `draft.partNumber` is the possibly-renamed target. If the original part number is empty, the product PATCH lookup would 400; in that case skip the product call and fall through to the per-lot PATCH only. Add this guard at the top of the `isManager` branch:

```tsx
        const origPN = (initialRef.current && JSON.parse(initialRef.current).partNumber) || item.part_number || '';
        if (origPN.trim()) {
          await api.patch('/api/inventory/product', {
            partNumber: origPN,
            newPartNumber: draft.partNumber || null,
            sellPrice: draft.sellPrice === '' ? null : Number(draft.sellPrice),
          });
        }
```

(Use `origPN` and delete the earlier `partNumber:`/`newPartNumber:` product call so there is exactly one product PATCH, guarded.)

- [ ] **Step 4: Typecheck**

Run: `cd apps/frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Manual browser verification**

With the stack running:
- As **manager**: open a product that has ≥2 lots (same part number across POs). Change sell price, save. Re-open the drawer → changelog shows ONE "Sell price → $X · applied to N lots" row; every lot's sell price changed; qty/unit cost/status on each lot are unchanged.
- As **manager**: rename the part number; confirm both lots now group under the new part number (drawer + grouped table).
- As **purchaser** (own lot): save still works as before (single per-line update); a lot owned by another purchaser is unaffected.

Record pass/fail per bullet. If you cannot run a browser, say so explicitly.

- [ ] **Step 6: Full suites + commit**

Run: `cd apps/backend && npx vitest run && cd ../frontend && npx vitest run && npx tsc -b && cd ../..`
Expected: all PASS, no type errors.

```bash
git add apps/frontend/src/pages/desktop/DesktopInventoryEdit.tsx
git commit -m "feat(inventory): manager edits save product-wide, per-lot for qty/cost/status"
```

---

## Self-Review

**Spec coverage:**
- Augment `by-part` (order_id+qty) → Task 1 ✓
- Manager-only product-scoped spec+sell-price edit, all lots, qty/cost/status untouched → Tasks 2-3 ✓
- Per-lot event + UI collapse → Task 2 (shared `created_at`) + Task 4 (`collapseProductEvents`) ✓
- Product Detail drawer replaces Quick View, changelog centerpiece, PO chip+qty → Task 5 ✓
- Edit page product-scoped for managers, per-lot for qty/cost/status, purchaser unchanged → Task 6 ✓
- Permissions (403 purchaser), 400/404, part-number re-group → Task 3 ✓
- Out-of-scope items (no new event kinds, no qty snapshots, no group-by-PO, no route, no purchaser product edit) → respected; nothing in the plan adds them ✓

**Placeholder scan:** No TBD/TODO; every code step has full code; the rename test has its final form spelled out (the throwaway first version is explicitly replaced before running).

**Type consistency:** `ProductEvent`/`CollapsedEvent` defined in Task 4 are the exact types consumed by Task 5's drawer. Endpoint accepts `partNumber` (lookup) + `newPartNumber` (rename target) consistently across Tasks 2/3/6. `collapseProductEvents` name matches between `changelog.ts`, its test, and the drawer import.

**Note for the implementer:** Several frontend import paths (`useEscapeKey`, `IconName`, `InventoryRow`, `useAuth` shape, `navigate`) are best-effort from inspection. Each frontend task says to verify against the existing file and align rather than invent exports — honor that; a `tsc -b` gate catches mismatches before commit.
