# Transfer Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the flat in-transit line list into first-class **Transfer Orders** (`TO-<n>`): a transfer creates an order grouping the moved items; managers confirm, re-open, export (CSV), and print (manifest) a whole order.

**Architecture:** New `transfer_orders` table + nullable `order_lines.transfer_order_id`. `POST /transfer` creates the order inside its existing transaction. New `GET /transfer-orders`, `POST /transfer-orders/:id/receive`, `POST /transfer-orders/:id/reopen` replace the old `GET /transfers` + `POST /receive`. The `DesktopTransfers` page becomes an order-card view with a status filter; manifest is browser-print HTML (no new deps). Greenfield — no backfill.

**Tech Stack:** Hono + `postgres` tagged templates (backend, Vitest, real shared Postgres), React 18 + tiny hash router (frontend, Vitest for pure fns only), bilingual i18n (en/zh).

Spec: `docs/superpowers/specs/2026-05-16-transfer-orders-design.md`

**Cross-cutting constraints (every task):**
- There is unrelated pre-existing WIP on `main` (`apps/frontend/src/MobileApp.tsx`, `apps/frontend/src/pages/Camera.tsx`, `apps/frontend/src/pages/SubmitForm.tsx`). NEVER `git add -A` / `git add .` / `git commit -a`. Only `git add` the explicit paths each task lists.
- Work directly on `main` (user's workflow — no feature branch).
- Backend tests: `pnpm --filter recycle-erp-backend test -- <name>`; `resetDb()` re-applies ALL migrations (sorted) + reseeds before each test, so a new `00NN_*.sql` is picked up automatically.

---

### Task 1: Migration — `transfer_orders` table + `order_lines.transfer_order_id`

**Files:**
- Create: `apps/backend/migrations/0028_transfer_orders.sql`
- Create: `apps/backend/tests/transfer-orders.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/transfer-orders.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

describe('migration 0028 — transfer_orders schema', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates transfer_orders and order_lines.transfer_order_id', async () => {
    const db = getTestDb();
    const t = await db`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'transfer_orders' ORDER BY column_name
    `;
    const cols = t.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'from_warehouse_id', 'to_warehouse_id', 'note',
      'created_by', 'created_at', 'status', 'received_at', 'received_by',
    ]));
    const ol = await db`
      SELECT 1 AS ok FROM information_schema.columns
      WHERE table_name = 'order_lines' AND column_name = 'transfer_order_id'
    `;
    expect(ol.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: FAIL — `transfer_orders` has no columns / `transfer_order_id` missing.

- [ ] **Step 3: Write the migration**

Create `apps/backend/migrations/0028_transfer_orders.sql`:

```sql
-- 0028_transfer_orders.sql
-- First-class transfer orders. A transfer groups the moved lines under one
-- TO-<n> order with its own Pending → Received lifecycle. order_lines points
-- to the order it is *currently* moving under; durable history stays in
-- inventory_events. Greenfield — no backfill of pre-change transfers.

CREATE TABLE IF NOT EXISTS transfer_orders (
  id                 TEXT PRIMARY KEY,
  from_warehouse_id  TEXT REFERENCES warehouses(id),   -- NULL = mixed sources
  to_warehouse_id    TEXT NOT NULL REFERENCES warehouses(id),
  note               TEXT,
  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL DEFAULT 'Pending',  -- Pending | Received
  received_at        TIMESTAMPTZ,
  received_by        UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS transfer_orders_status_idx
  ON transfer_orders(status, created_at DESC);

ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS transfer_order_id TEXT REFERENCES transfer_orders(id);
CREATE INDEX IF NOT EXISTS order_lines_transfer_order_idx
  ON order_lines(transfer_order_id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/migrations/0028_transfer_orders.sql apps/backend/tests/transfer-orders.test.ts
git commit -m "feat(backend): transfer_orders table + order_lines.transfer_order_id (0028)"
```

---

### Task 2: `POST /transfer` creates the transfer order

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` — the `inventory.post('/transfer', ...)` handler (currently lines ~337-500)
- Modify: `apps/backend/tests/transfer-orders.test.ts` (append)

Old `apps/backend/tests/transfers.test.ts` and the old `/transfers` + `/receive` endpoints remain untouched in this task (still green).

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/tests/transfer-orders.test.ts`:

```typescript
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

type InvRow = { id: string; status: string; warehouse_id: string | null; qty: number };
const WAREHOUSES = ['WH-LA1', 'WH-DAL', 'WH-NJ2', 'WH-HK', 'WH-AMS'];

// Full-move transfer one sellable line to a different warehouse.
// Returns the line id, its source/dest warehouse, and the new TO order id.
async function transferOne(token: string): Promise<{ id: string; from: string; to: string; orderId: string }> {
  const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
  const line = inv.body.items.find(
    (i) => (i.status === 'Reviewing' || i.status === 'Done') && i.warehouse_id,
  );
  if (!line) throw new Error('no sellable line in seed');
  const to = WAREHOUSES.find((w) => w !== line.warehouse_id)!;
  const r = await api<{ ok: true; transferOrderId: string }>(
    'POST', '/api/inventory/transfer',
    { token, body: { toWarehouseId: to, lines: [{ id: line.id, qty: line.qty }] } },
  );
  expect(r.status).toBe(200);
  expect(typeof r.body.transferOrderId).toBe('string');
  return { id: line.id, from: line.warehouse_id!, to, orderId: r.body.transferOrderId };
}

describe('POST /api/inventory/transfer — creates a transfer order', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates one TO-<n> order and links the moved line', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    expect(moved.orderId).toMatch(/^TO-\d+$/);

    const db = getTestDb();
    const ord = (await db`SELECT * FROM transfer_orders WHERE id = ${moved.orderId}`)[0] as
      Record<string, unknown>;
    expect(ord).toBeDefined();
    expect(ord.status).toBe('Pending');
    expect(ord.to_warehouse_id).toBe(moved.to);
    expect(ord.from_warehouse_id).toBe(moved.from); // single source
    expect(ord.received_at).toBeNull();

    const ln = (await db`SELECT transfer_order_id FROM order_lines WHERE id = ${moved.id}`)[0] as
      { transfer_order_id: string };
    expect(ln.transfer_order_id).toBe(moved.orderId);

    const ev = (await db`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${moved.id} AND kind = 'transferred'
      ORDER BY created_at DESC LIMIT 1
    `)[0] as { detail: Record<string, unknown> };
    expect(ev.detail.transfer_order_id).toBe(moved.orderId);
  });

  it('uses NULL from_warehouse_id when sources differ', async () => {
    const { token } = await loginAs(ALEX);
    const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
    const sellable = inv.body.items.filter(
      (i) => (i.status === 'Reviewing' || i.status === 'Done') && i.warehouse_id,
    );
    const a = sellable[0]!;
    const b = sellable.find((i) => i.warehouse_id !== a.warehouse_id);
    if (!b) { expect(true).toBe(true); return; } // seed lacked 2 distinct sources — skip
    const to = WAREHOUSES.find((w) => w !== a.warehouse_id && w !== b.warehouse_id)!;
    const r = await api<{ ok: true; transferOrderId: string }>(
      'POST', '/api/inventory/transfer',
      { token, body: { toWarehouseId: to, lines: [
        { id: a.id, qty: a.qty }, { id: b.id, qty: b.qty },
      ] } },
    );
    expect(r.status).toBe(200);
    const db = getTestDb();
    const ord = (await db`SELECT from_warehouse_id FROM transfer_orders WHERE id = ${r.body.transferOrderId}`)[0] as
      { from_warehouse_id: string | null };
    expect(ord.from_warehouse_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: FAIL — response has no `transferOrderId`; no `transfer_orders` row.

- [ ] **Step 3: Modify the `/transfer` handler**

In `apps/backend/src/routes/inventory.ts`, in `inventory.post('/transfer', ...)`:

(a) The handler currently ends the validation loop then has:

```typescript
  type ResultLine = { sourceId: string; destId: string; qty: number };
  const result: ResultLine[] = [];

  await sql.begin(async (tx) => {
    for (const r of reqLines) {
      const s = byId.get(r.id)!;
      const fromWh = s.effective_wh ?? '';
```

Replace that block's opening (the `await sql.begin(async (tx) => {` line and the lines immediately after, up to but not including `for (const r of reqLines) {`) with id generation + order insert. Specifically, change:

```typescript
  type ResultLine = { sourceId: string; destId: string; qty: number };
  const result: ResultLine[] = [];

  await sql.begin(async (tx) => {
    for (const r of reqLines) {
```

to:

```typescript
  type ResultLine = { sourceId: string; destId: string; qty: number };
  const result: ResultLine[] = [];

  // Single common source if every line shares one effective warehouse,
  // else NULL (mixed-source transfer order).
  const sourceSet = new Set(reqLines.map((r) => byId.get(r.id)!.effective_wh ?? ''));
  const fromWarehouse = sourceSet.size === 1 ? [...sourceSet][0]! || null : null;

  let transferOrderId = '';

  await sql.begin(async (tx) => {
    const maxRow = (await tx`
      SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 4) AS INTEGER)), 1000) AS max
      FROM transfer_orders WHERE id LIKE 'TO-%' AND id ~ '^TO-[0-9]+$'
    `)[0] as { max: number };
    transferOrderId = 'TO-' + (maxRow.max + 1);
    await tx`
      INSERT INTO transfer_orders (id, from_warehouse_id, to_warehouse_id, note, created_by, status)
      VALUES (${transferOrderId}, ${fromWarehouse}, ${toWarehouseId}, ${note}, ${u.id}, 'Pending')
    `;

    for (const r of reqLines) {
```

(b) In the **full-move** branch, the UPDATE + event currently are:

```typescript
        await tx`
          UPDATE order_lines
             SET warehouse_id = ${toWarehouseId}, status = 'In Transit'
           WHERE id = ${r.id}
        `;
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
          VALUES (${r.id}, ${u.id}, 'transferred',
                  ${tx.json({ from: fromWh, to: toWarehouseId, qty: r.qty, ...(note ? { note } : {}) })})
        `;
```

Replace with (add `transfer_order_id` to the line and the event detail):

```typescript
        await tx`
          UPDATE order_lines
             SET warehouse_id = ${toWarehouseId}, status = 'In Transit',
                 transfer_order_id = ${transferOrderId}
           WHERE id = ${r.id}
        `;
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
          VALUES (${r.id}, ${u.id}, 'transferred',
                  ${tx.json({ from: fromWh, to: toWarehouseId, qty: r.qty, transfer_order_id: transferOrderId, ...(note ? { note } : {}) })})
        `;
```

(c) In the **partial** branch, the clone INSERT currently lists columns ending `health, rpm, warehouse_id` and values ending `${s.health}, ${s.rpm}, ${toWarehouseId}`. Add `transfer_order_id`:

Change the column list tail `health, rpm, warehouse_id` to `health, rpm, warehouse_id, transfer_order_id` and the values tail `${s.health}, ${s.rpm}, ${toWarehouseId}` to `${s.health}, ${s.rpm}, ${toWarehouseId}, ${transferOrderId}`.

Then in that same branch the two event inserts use `detail` / spreads. Change:

```typescript
        const detail = { from: fromWh, to: toWarehouseId, qty: r.qty, ...(note ? { note } : {}) };
```

to:

```typescript
        const detail = { from: fromWh, to: toWarehouseId, qty: r.qty, transfer_order_id: transferOrderId, ...(note ? { note } : {}) };
```

(The two `tx.json({ ...detail, peer_line_id: ... })` inserts then carry `transfer_order_id` automatically.)

(d) The final return currently is `return c.json({ ok: true, lines: result });`. Change to:

```typescript
  return c.json({ ok: true, transferOrderId, lines: result });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: PASS (schema + creation describe blocks).
Run: `pnpm --filter recycle-erp-backend test -- transfers`
Expected: the OLD `transfers.test.ts` still PASSES (old endpoints untouched; extra event field + new column don't break its assertions).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter recycle-erp-backend typecheck
git add apps/backend/src/routes/inventory.ts apps/backend/tests/transfer-orders.test.ts
git commit -m "feat(backend): /transfer creates a TO-<n> transfer order"
```

Expected typecheck: no errors.

---

### Task 3: `GET /transfer-orders` replaces `GET /transfers`

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` — replace the `inventory.get('/transfers', ...)` handler (currently lines ~118-157) with `inventory.get('/transfer-orders', ...)` (keep it before `inventory.get('/:id', ...)` so it isn't shadowed)
- Delete: `apps/backend/tests/transfers.test.ts` (its `/transfers` tests are obsolete; `/receive` coverage moves to the new file in Task 4)
- Modify: `apps/backend/tests/transfer-orders.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/tests/transfer-orders.test.ts`:

```typescript
import { MARCUS } from './helpers/auth';

describe('GET /api/inventory/transfer-orders', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('GET', '/api/inventory/transfer-orders', { token });
    expect(r.status).toBe(403);
  });

  it('default lists Pending orders with their lines + from/to enrichment', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const r = await api<{ orders: Array<{
      id: string; status: string; to_warehouse_id: string; from_warehouse_id: string | null;
      item_count: number; unit_count: number;
      lines: Array<{ id: string; from_wh: string | null; qty: number }>;
    }> }>('GET', '/api/inventory/transfer-orders', { token });
    expect(r.status).toBe(200);
    const ord = r.body.orders.find((o) => o.id === moved.orderId);
    expect(ord).toBeDefined();
    expect(ord!.status).toBe('Pending');
    expect(ord!.to_warehouse_id).toBe(moved.to);
    expect(ord!.item_count).toBe(1);
    expect(ord!.unit_count).toBeGreaterThanOrEqual(1);
    const line = ord!.lines.find((l) => l.id === moved.id);
    expect(line).toBeDefined();
    expect(line!.from_wh).toBe(moved.from);
  });

  it('status=all includes the order; default (pending) does too while Pending', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const all = await api<{ orders: Array<{ id: string }> }>(
      'GET', '/api/inventory/transfer-orders?status=all', { token },
    );
    expect(all.body.orders.some((o) => o.id === moved.orderId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: FAIL — `GET /api/inventory/transfer-orders` does not exist (404 / shape mismatch).

- [ ] **Step 3: Replace the endpoint**

In `apps/backend/src/routes/inventory.ts`, delete the entire `inventory.get('/transfers', async (c) => { ... });` block (the comment above it starting `// In-transit inventory awaiting receipt.` through its closing `});`) and replace it with:

```typescript
// Transfer orders. Manager-only. ?status=pending|received|all (default
// pending). Each order carries its currently-linked lines (In Transit while
// Pending, Done while Received), enriched with each line's prior 'from'
// warehouse from its latest 'transferred' event.
inventory.get('/transfer-orders', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);

  const sp = (c.req.query('status') ?? 'pending').toLowerCase();
  const statusFrag =
    sp === 'received' ? sql`t.status = 'Received'`
    : sp === 'all'    ? sql`TRUE`
    :                   sql`t.status = 'Pending'`;

  const orders = (await sql`
    SELECT t.id, t.from_warehouse_id, t.to_warehouse_id, t.note, t.status,
           t.created_at, t.received_at,
           fw.short AS from_short, tw.short AS to_short,
           cu.name  AS created_by_name,
           (SELECT COUNT(*)::int FROM order_lines ol WHERE ol.transfer_order_id = t.id)             AS item_count,
           (SELECT COALESCE(SUM(ol.qty),0)::int FROM order_lines ol WHERE ol.transfer_order_id = t.id) AS unit_count
    FROM transfer_orders t
    LEFT JOIN warehouses fw ON fw.id = t.from_warehouse_id
    LEFT JOIN warehouses tw ON tw.id = t.to_warehouse_id
    LEFT JOIN users cu      ON cu.id = t.created_by
    WHERE ${statusFrag}
    ORDER BY t.created_at DESC
    LIMIT 200
  `) as unknown as Array<Record<string, unknown> & { id: string }>;

  const orderIds = orders.map((o) => o.id);
  type LineRow = Record<string, unknown> & { transfer_order_id: string };
  const lines = orderIds.length === 0 ? [] : (await sql`
    SELECT l.id, l.transfer_order_id, l.category, l.brand, l.capacity, l.generation,
           l.type, l.description, l.part_number, l.qty, l.position, l.status,
           te.detail->>'from' AS from_wh,
           fw.short AS from_short,
           te.created_at AS transferred_at
    FROM order_lines l
    JOIN LATERAL (
      SELECT e.detail, e.created_at
      FROM inventory_events e
      WHERE e.order_line_id = l.id AND e.kind = 'transferred'
      ORDER BY e.created_at DESC
      LIMIT 1
    ) te ON TRUE
    LEFT JOIN warehouses fw ON fw.id = te.detail->>'from'
    WHERE l.transfer_order_id = ANY(${orderIds}::text[])
    ORDER BY l.position
  `) as unknown as LineRow[];

  const byOrder = new Map<string, LineRow[]>();
  for (const ln of lines) {
    const b = byOrder.get(ln.transfer_order_id);
    if (b) b.push(ln);
    else byOrder.set(ln.transfer_order_id, [ln]);
  }
  return c.json({
    orders: orders.map((o) => ({ ...o, lines: byOrder.get(o.id) ?? [] })),
  });
});
```

- [ ] **Step 4: Delete the obsolete old test file**

Run: `git rm apps/backend/tests/transfers.test.ts`

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: PASS (schema + creation + list describe blocks).
Run: `pnpm --filter recycle-erp-backend test`
Expected: full suite PASS, no reference to the deleted `transfers.test.ts`.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter recycle-erp-backend typecheck
git add apps/backend/src/routes/inventory.ts apps/backend/tests/transfer-orders.test.ts apps/backend/tests/transfers.test.ts
git commit -m "feat(backend): GET /transfer-orders replaces GET /transfers"
```

(`git add` of the deleted path stages the deletion.)

---

### Task 4: `POST /transfer-orders/:id/receive` replaces `POST /receive`

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` — delete the `inventory.post('/receive', ...)` handler (currently ~lines 506-557) and add `inventory.post('/transfer-orders/:id/receive', ...)`
- Modify: `apps/backend/tests/transfer-orders.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/tests/transfer-orders.test.ts`:

```typescript
describe('POST /api/inventory/transfer-orders/:id/receive', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/inventory/transfer-orders/TO-1/receive', { token });
    expect(r.status).toBe(403);
  });

  it('404 for unknown order', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/inventory/transfer-orders/TO-999999/receive', { token });
    expect(r.status).toBe(404);
  });

  it('receives the whole order: lines Done, order Received', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const r = await api<{ ok: true; id: string }>(
      'POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token },
    );
    expect(r.status).toBe(200);

    const db = getTestDb();
    const ord = (await db`SELECT status, received_at FROM transfer_orders WHERE id = ${moved.orderId}`)[0] as
      { status: string; received_at: string | null };
    expect(ord.status).toBe('Received');
    expect(ord.received_at).not.toBeNull();
    const ln = (await db`SELECT status FROM order_lines WHERE id = ${moved.id}`)[0] as { status: string };
    expect(ln.status).toBe('Done');
    const ev = (await db`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${moved.id} AND kind = 'received' ORDER BY created_at DESC LIMIT 1
    `)[0] as { detail: Record<string, unknown> };
    expect(ev.detail.transfer_order_id).toBe(moved.orderId);
    expect(ev.detail.at).toBe(moved.to);

    // No longer under default (pending) listing; present under received.
    const pend = await api<{ orders: Array<{ id: string }> }>(
      'GET', '/api/inventory/transfer-orders', { token },
    );
    expect(pend.body.orders.some((o) => o.id === moved.orderId)).toBe(false);
    const recv = await api<{ orders: Array<{ id: string }> }>(
      'GET', '/api/inventory/transfer-orders?status=received', { token },
    );
    expect(recv.body.orders.some((o) => o.id === moved.orderId)).toBe(true);
  });

  it('400 when the order is already Received', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token });
    const again = await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token });
    expect(again.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: FAIL — new receive route does not exist.

- [ ] **Step 3: Replace the endpoint**

In `apps/backend/src/routes/inventory.ts`, delete the entire old receive block (the comment starting `// Bulk receive. Manager-only.` through the closing `});` of `inventory.post('/receive', ...)`). Add in its place:

```typescript
// Receive a whole transfer order. Manager-only. Every still-In-Transit line
// under the order → Done + a 'received' event; order → Received.
inventory.post('/transfer-orders/:id/receive', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const ord = (await sql`
    SELECT id, status, to_warehouse_id FROM transfer_orders WHERE id = ${id} LIMIT 1
  `)[0] as { id: string; status: string; to_warehouse_id: string } | undefined;
  if (!ord) return c.json({ error: `transfer order ${id} not found` }, 404);
  if (ord.status !== 'Pending') {
    return c.json({ error: `transfer order ${id} is ${ord.status}; only Pending can be received` }, 400);
  }

  await sql.begin(async (tx) => {
    const lines = (await tx`
      SELECT id FROM order_lines
      WHERE transfer_order_id = ${id} AND status = 'In Transit'
    `) as unknown as Array<{ id: string }>;
    for (const ln of lines) {
      await tx`UPDATE order_lines SET status = 'Done' WHERE id = ${ln.id}`;
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        VALUES (${ln.id}, ${u.id}, 'received',
                ${tx.json({ at: ord.to_warehouse_id, transfer_order_id: id })})
      `;
    }
    await tx`
      UPDATE transfer_orders
         SET status = 'Received', received_at = NOW(), received_by = ${u.id}
       WHERE id = ${id}
    `;
  });

  return c.json({ ok: true, id });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: PASS (schema + creation + list + receive).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter recycle-erp-backend typecheck
git add apps/backend/src/routes/inventory.ts apps/backend/tests/transfer-orders.test.ts
git commit -m "feat(backend): POST /transfer-orders/:id/receive replaces POST /receive"
```

---

### Task 5: `POST /transfer-orders/:id/reopen`

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` — add `inventory.post('/transfer-orders/:id/reopen', ...)` immediately after the `/transfer-orders/:id/receive` handler
- Modify: `apps/backend/tests/transfer-orders.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/tests/transfer-orders.test.ts`:

```typescript
describe('POST /api/inventory/transfer-orders/:id/reopen', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/inventory/transfer-orders/TO-1/reopen', { token });
    expect(r.status).toBe(403);
  });

  it('400 when the order is not Received', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token); // still Pending
    const r = await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/reopen`, { token });
    expect(r.status).toBe(400);
  });

  it('reverts a clean received order back to Pending / In Transit', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token });
    const r = await api<{ ok: true; id: string }>(
      'POST', `/api/inventory/transfer-orders/${moved.orderId}/reopen`, { token },
    );
    expect(r.status).toBe(200);
    const db = getTestDb();
    const ord = (await db`SELECT status, received_at FROM transfer_orders WHERE id = ${moved.orderId}`)[0] as
      { status: string; received_at: string | null };
    expect(ord.status).toBe('Pending');
    expect(ord.received_at).toBeNull();
    const ln = (await db`SELECT status FROM order_lines WHERE id = ${moved.id}`)[0] as { status: string };
    expect(ln.status).toBe('In Transit');
    const ev = (await db`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${moved.id} AND kind = 'reopened' ORDER BY created_at DESC LIMIT 1
    `)[0] as { detail: Record<string, unknown> };
    expect(ev.detail.transfer_order_id).toBe(moved.orderId);
  });

  it('409 (no writes) when a line is committed to a sell order', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token });
    // Reuse a seeded sell order (avoids fabricating sell_orders + its FKs);
    // just add a sell_order_lines row pointing at our received line.
    const db = getTestDb();
    const so = (await db`SELECT id FROM sell_orders ORDER BY created_at LIMIT 1`)[0] as
      { id: string } | undefined;
    expect(so).toBeDefined(); // seed has sell orders
    await db`INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price)
             VALUES (${so!.id}, ${moved.id}, 'RAM', 'x', 1, 1)`;
    const r = await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/reopen`, { token });
    expect(r.status).toBe(409);
    const ord = (await db`SELECT status FROM transfer_orders WHERE id = ${moved.orderId}`)[0] as
      { status: string };
    expect(ord.status).toBe('Received'); // unchanged — no writes
  });
});
```

> Note: this reuses a seeded `sell_orders` row and only inserts a minimal
> `sell_order_lines` row (`sell_order_id, inventory_id, category, label, qty,
> unit_price`). If that INSERT fails on a NOT-NULL/extra-required column,
> read the `sell_order_lines` definition in `apps/backend/migrations/0002_desktop.sql`
> and supply the minimal required columns — do NOT change production code to
> satisfy the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: FAIL — reopen route does not exist.

- [ ] **Step 3: Implement the endpoint**

In `apps/backend/src/routes/inventory.ts`, immediately after the `/transfer-orders/:id/receive` handler's closing `});`, add:

```typescript
// Re-open a received transfer order. Manager-only. Reverts the lines that
// CURRENTLY point to the order (a line re-transferred elsewhere had its
// transfer_order_id overwritten and is intentionally not chased). Guard:
// every such line must still be Done and not committed to a sell order.
inventory.post('/transfer-orders/:id/reopen', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const ord = (await sql`
    SELECT id, status FROM transfer_orders WHERE id = ${id} LIMIT 1
  `)[0] as { id: string; status: string } | undefined;
  if (!ord) return c.json({ error: `transfer order ${id} not found` }, 404);
  if (ord.status !== 'Received') {
    return c.json({ error: `transfer order ${id} is ${ord.status}; only Received can be re-opened` }, 400);
  }

  const lines = (await sql`
    SELECT l.id, l.status,
           EXISTS (SELECT 1 FROM sell_order_lines sl WHERE sl.inventory_id = l.id) AS in_sell_order
    FROM order_lines l
    WHERE l.transfer_order_id = ${id}
  `) as unknown as Array<{ id: string; status: string; in_sell_order: boolean }>;

  if (lines.length === 0) {
    return c.json({ error: `transfer order ${id} has no lines to re-open` }, 409);
  }
  const bad = lines.filter((l) => l.status !== 'Done' || l.in_sell_order);
  if (bad.length > 0) {
    const ids = bad.map((l) => l.id).join(', ');
    return c.json({ error: `cannot re-open: line(s) ${ids} have moved on since receipt` }, 409);
  }

  await sql.begin(async (tx) => {
    for (const l of lines) {
      await tx`UPDATE order_lines SET status = 'In Transit' WHERE id = ${l.id}`;
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        VALUES (${l.id}, ${u.id}, 'reopened', ${tx.json({ transfer_order_id: id })})
      `;
    }
    await tx`
      UPDATE transfer_orders
         SET status = 'Pending', received_at = NULL, received_by = NULL
       WHERE id = ${id}
    `;
  });

  return c.json({ ok: true, id });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter recycle-erp-backend test -- transfer-orders`
Expected: PASS (all five describe blocks).

- [ ] **Step 5: Typecheck + full suite + commit**

```bash
pnpm --filter recycle-erp-backend typecheck
pnpm --filter recycle-erp-backend test
git add apps/backend/src/routes/inventory.ts apps/backend/tests/transfer-orders.test.ts
git commit -m "feat(backend): POST /transfer-orders/:id/reopen with safety guard"
```

Expected: typecheck clean; full backend suite green.

---

### Task 6: i18n strings (en + zh)

**Files:**
- Modify: `apps/frontend/src/lib/i18n.tsx` (en block ~lines 219-231; zh block ~lines 409-413)

- [ ] **Step 1: Replace the English transfers block**

In `apps/frontend/src/lib/i18n.tsx`, the `en:` map currently has lines 219-231 (`nav_transfers` … `transfersReceiveError`). Replace that whole contiguous block with:

```typescript
    nav_transfers: 'Transfers',
    transfersTitle: 'Transfer orders',
    transfersSubtitle: 'Inventory moving between warehouses, grouped by order.',
    transfersEmpty: 'No transfer orders.',
    transfersConfirm: 'Confirm received',
    transfersReopen: 'Re-open',
    transfersExport: 'Export CSV',
    transfersManifest: 'Print manifest',
    transfersColItem: 'Item',
    transfersColQty: 'Qty',
    transfersColFrom: 'From',
    transfersColDate: 'Transferred',
    transfersFilterPending: 'Pending',
    transfersFilterReceived: 'Received',
    transfersFilterAll: 'All',
    transfersMixed: 'Mixed',
    transfersItems: '{n} item(s)',
    transfersReceived: 'Order {id} received',
    transfersReopened: 'Order {id} re-opened',
    transfersActionError: 'Action failed',
    transfersManifestTitle: 'Transfer manifest',
```

- [ ] **Step 2: Replace the Chinese transfers block**

The `zh:` map currently has lines ~409-413 (`nav_transfers: '调拨',` … `transfersReceiveError: '收货失败',`). Replace that whole contiguous block with:

```typescript
    nav_transfers: '调拨',
    transfersTitle: '调拨单', transfersSubtitle: '仓库间在途库存，按调拨单分组。',
    transfersEmpty: '没有调拨单。', transfersConfirm: '确认收货', transfersReopen: '重新打开',
    transfersExport: '导出 CSV', transfersManifest: '打印清单',
    transfersColItem: '物品', transfersColQty: '数量', transfersColFrom: '调出',
    transfersColDate: '调拨时间',
    transfersFilterPending: '待收货', transfersFilterReceived: '已收货', transfersFilterAll: '全部',
    transfersMixed: '多个', transfersItems: '{n} 件',
    transfersReceived: '调拨单 {id} 已收货', transfersReopened: '调拨单 {id} 已重新打开',
    transfersActionError: '操作失败', transfersManifestTitle: '调拨清单',
```

(This removes the now-unused `transfersColNote`, `transfersColBy`, `transfersReceiveError` and the old `transfersReceived: '{n} item(s) received'`; the new page references none of them.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: zero errors *in i18n.tsx*. The page still references old keys until Task 7 — it is acceptable if typecheck is clean (i18n values are a plain record; missing keys are only a runtime concern, and `t()` returns the key string for unknowns). If typecheck reports an unrelated pre-existing WIP-file error, report it but do not fix.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/i18n.tsx
git commit -m "i18n: transfer-orders strings (en + zh)"
```

---

### Task 7: Rework the `DesktopTransfers` page into order cards

**Files:**
- Modify (rewrite): `apps/frontend/src/pages/desktop/DesktopTransfers.tsx`

- [ ] **Step 1: Replace the file contents**

Overwrite `apps/frontend/src/pages/desktop/DesktopTransfers.tsx` with:

```typescript
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Icon } from '../../components/Icon';
import { statusTone } from '../../lib/status';
import { TransferManifest, printManifest } from './TransferManifest';

export type TransferLine = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  type: string | null;
  description: string | null;
  part_number: string | null;
  qty: number;
  from_wh: string | null;
  from_short: string | null;
  transferred_at: string;
};

export type TransferOrder = {
  id: string;
  from_warehouse_id: string | null;
  from_short: string | null;
  to_warehouse_id: string;
  to_short: string | null;
  note: string | null;
  status: string;
  created_at: string;
  received_at: string | null;
  created_by_name: string | null;
  item_count: number;
  unit_count: number;
  lines: TransferLine[];
};

type StatusFilter = 'pending' | 'received' | 'all';

type Props = {
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function lineLabel(l: TransferLine): string {
  return [l.brand, l.capacity, l.generation, l.part_number]
    .filter(Boolean)
    .join(' ') || l.description || l.category;
}

function downloadOrderCsv(order: TransferOrder): void {
  const head = ['Item', 'Qty', 'From', 'To', 'Transferred'];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const to = order.to_short ?? order.to_warehouse_id;
  const rows = order.lines.map((l) =>
    [
      lineLabel(l),
      String(l.qty),
      l.from_short ?? l.from_wh ?? '',
      to,
      new Date(l.transferred_at).toISOString(),
    ].map((c) => esc(String(c))).join(','),
  );
  const csv = [head.map(esc).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transfer-${order.id}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DesktopTransfers({ onToast }: Props = {}) {
  const { t } = useT();
  const [orders, setOrders] = useState<TransferOrder[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('pending');
  const [busy, setBusy] = useState<string | null>(null);
  const [printing, setPrinting] = useState<TransferOrder | null>(null);

  const load = (f: StatusFilter) => {
    api
      .get<{ orders: TransferOrder[] }>(`/api/inventory/transfer-orders?status=${f}`)
      .then((r) => setOrders(r.orders))
      .catch((e) => onToast?.(String(e), 'error'));
  };
  useEffect(() => load(filter), [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (order: TransferOrder, kind: 'receive' | 'reopen') => {
    setBusy(order.id);
    try {
      await api.post<{ ok: true; id: string }>(
        `/api/inventory/transfer-orders/${order.id}/${kind}`, {},
      );
      onToast?.(t(kind === 'receive' ? 'transfersReceived' : 'transfersReopened', { id: order.id }));
      load(filter);
    } catch (e) {
      onToast?.(t('transfersActionError') + ': ' + String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const fromLabel = (o: TransferOrder) =>
    o.from_warehouse_id ? (o.from_short ?? o.from_warehouse_id) : t('transfersMixed');

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('transfersTitle')}</h1>
          <div className="page-sub">{t('transfersSubtitle')}</div>
        </div>
        <div className="page-actions">
          {(['pending', 'received', 'all'] as StatusFilter[]).map((f) => (
            <button
              key={f}
              className={'btn' + (filter === f ? ' accent' : '')}
              onClick={() => setFilter(f)}
            >
              {t(f === 'pending' ? 'transfersFilterPending'
                : f === 'received' ? 'transfersFilterReceived'
                : 'transfersFilterAll')}
            </button>
          ))}
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="page-sub" style={{ padding: 24 }}>{t('transfersEmpty')}</div>
      ) : (
        orders.map((o) => (
          <div key={o.id} className="card" style={{ marginBottom: 16, padding: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              gap: 12, flexWrap: 'wrap', marginBottom: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontWeight: 600 }}>{o.id}</span>
                <span style={{ fontSize: 13 }}>
                  <span className="mono">{fromLabel(o)}</span>
                  <Icon name="arrow" size={11} style={{ margin: '0 6px', verticalAlign: 'middle' }} />
                  <span className="mono">{o.to_short ?? o.to_warehouse_id}</span>
                </span>
                <span className={'chip ' + statusTone(o.status)} style={{ fontSize: 11 }}>{o.status}</span>
                <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                  {t('transfersItems', { n: o.item_count })} · {new Date(o.created_at).toLocaleDateString()}
                  {o.created_by_name ? ' · ' + o.created_by_name : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => setPrinting(o)}>
                  <Icon name="file" size={13} /> {t('transfersManifest')}
                </button>
                <button className="btn" onClick={() => downloadOrderCsv(o)}>
                  <Icon name="download" size={13} /> {t('transfersExport')}
                </button>
                {o.status === 'Pending' && (
                  <button className="btn accent" disabled={busy === o.id}
                          onClick={() => act(o, 'receive')}>
                    <Icon name="check" size={13} /> {t('transfersConfirm')}
                  </button>
                )}
                {o.status === 'Received' && (
                  <button className="btn" disabled={busy === o.id}
                          onClick={() => act(o, 'reopen')}>
                    <Icon name="refresh" size={13} /> {t('transfersReopen')}
                  </button>
                )}
              </div>
            </div>
            {o.note && (
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginBottom: 8 }}>{o.note}</div>
            )}
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('transfersColItem')}</th>
                  <th style={{ textAlign: 'right' }}>{t('transfersColQty')}</th>
                  <th>{t('transfersColFrom')}</th>
                  <th>{t('transfersColDate')}</th>
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{lineLabel(l)}</td>
                    <td style={{ textAlign: 'right' }}>{l.qty}</td>
                    <td>{l.from_short ?? l.from_wh ?? ''}</td>
                    <td>{new Date(l.transferred_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {printing && (
        <TransferManifest
          order={printing}
          onClose={() => setPrinting(null)}
          onReady={printManifest}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify referenced imports exist**

Run: `grep -n "export const statusTone\|export function statusTone" apps/frontend/src/lib/status.ts; grep -n "'file'\|'refresh'\|'arrow'\|'check'\|'download'" apps/frontend/src/components/Icon.tsx | head`
Expected: `statusTone` is exported from `status.ts`; `file`, `refresh`, `arrow`, `check`, `download` are all valid `IconName`s. If `statusTone` is named/located differently, mirror how `DesktopActivityDrawer.tsx` imports it. If an icon name is invalid, pick the closest valid one from the `IconName` union in `Icon.tsx` and note the substitution.

- [ ] **Step 3: Typecheck (expected to fail until Task 8)**

`TransferManifest`/`printManifest` do not exist yet (Task 8). Do NOT build here. Just confirm the rest of the file is structurally complete by reviewing it. Proceed to commit in Task 8 once the manifest module exists.

- [ ] **Step 4: Do not commit yet**

This file is committed together with Task 8 (it imports `./TransferManifest`). Leave it modified in the working tree. Run `git status --porcelain` and confirm `DesktopTransfers.tsx` shows modified and the 3 WIP files are untouched.

---

### Task 8: `TransferManifest` print component + print CSS

**Files:**
- Create: `apps/frontend/src/pages/desktop/TransferManifest.tsx`
- Modify: `apps/frontend/src/index.css` (append a print scope) — confirm the global stylesheet path first (see Step 2)

- [ ] **Step 1: Create the manifest component**

Create `apps/frontend/src/pages/desktop/TransferManifest.tsx`:

```typescript
import { useEffect } from 'react';
import { useT } from '../../lib/i18n';
import type { TransferOrder } from './DesktopTransfers';
import { lineLabel } from './DesktopTransfers';

export function printManifest(): void {
  window.print();
}

type Props = {
  order: TransferOrder;
  onClose: () => void;
  onReady: () => void;
};

// Renders a print-only packing list. The `.transfer-manifest` element is
// hidden on screen and shown for print; `.app-no-print` (the app shell)
// is hidden for print. See the print scope in index.css.
export function TransferManifest({ order, onClose, onReady }: Props) {
  const { t } = useT();

  useEffect(() => {
    const after = () => onClose();
    window.addEventListener('afterprint', after);
    // Defer so the manifest is in the DOM before the print dialog opens.
    const id = window.setTimeout(onReady, 50);
    return () => {
      window.removeEventListener('afterprint', after);
      window.clearTimeout(id);
    };
  }, [onClose, onReady]);

  const to = order.to_short ?? order.to_warehouse_id;
  const from = order.from_short ?? order.from_warehouse_id ?? t('transfersMixed');
  const units = order.lines.reduce((s, l) => s + l.qty, 0);

  return (
    <div className="transfer-manifest">
      <h1 style={{ marginBottom: 4 }}>{t('transfersManifestTitle')}</h1>
      <div style={{ fontFamily: 'monospace', fontSize: 18, marginBottom: 12 }}>{order.id}</div>
      <table style={{ width: '100%', marginBottom: 16, fontSize: 13 }}>
        <tbody>
          <tr><td><strong>From</strong></td><td>{from}</td>
              <td><strong>To</strong></td><td>{to}</td></tr>
          <tr><td><strong>Created</strong></td><td>{new Date(order.created_at).toLocaleString()}</td>
              <td><strong>By</strong></td><td>{order.created_by_name ?? ''}</td></tr>
          <tr><td><strong>Status</strong></td><td>{order.status}</td>
              <td><strong>Note</strong></td><td>{order.note ?? ''}</td></tr>
        </tbody>
      </table>
      <table className="data-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>{t('transfersColItem')}</th>
            <th style={{ textAlign: 'right' }}>{t('transfersColQty')}</th>
            <th style={{ textAlign: 'left' }}>{t('transfersColFrom')}</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.id}>
              <td>{lineLabel(l)}</td>
              <td style={{ textAlign: 'right' }}>{l.qty}</td>
              <td>{l.from_short ?? l.from_wh ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 16, fontSize: 13 }}>
        <strong>{t('transfersItems', { n: order.item_count })}</strong> · {units} units
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the print scope to the global stylesheet**

Run: `ls apps/frontend/src/index.css apps/frontend/src/styles.css apps/frontend/src/*.css 2>/dev/null; grep -rn "import './index.css'\|import './styles" apps/frontend/src/main.tsx apps/frontend/src/main.ts 2>/dev/null`
Identify the global stylesheet the app actually imports (likely `apps/frontend/src/index.css`). Append to that file:

```css
/* ── Transfer manifest print scope ──────────────────────────────────────── */
.transfer-manifest { display: none; }
@media print {
  body * { visibility: hidden; }
  .transfer-manifest, .transfer-manifest * { visibility: visible; }
  .transfer-manifest {
    display: block;
    position: absolute;
    inset: 0;
    padding: 24px;
    background: #fff;
    color: #000;
  }
}
```

- [ ] **Step 3: Typecheck + build (validates Task 7 + 8 together)**

Run: `pnpm --filter recycle-erp-frontend typecheck && pnpm --filter recycle-erp-frontend build`
Expected: zero type errors in `DesktopTransfers.tsx` / `TransferManifest.tsx`; build succeeds. If the ONLY errors are in the unrelated WIP files (`MobileApp.tsx`/`Camera.tsx`/`SubmitForm.tsx`), report them but do not fix. Fix any error originating in the two new/changed files.

- [ ] **Step 4: Commit (page + manifest + css together)**

```bash
git add apps/frontend/src/pages/desktop/DesktopTransfers.tsx \
        apps/frontend/src/pages/desktop/TransferManifest.tsx \
        apps/frontend/src/index.css
git commit -m "feat(frontend): transfer-order cards, filter, re-open, per-order CSV + print manifest"
```

(If the global stylesheet was a different path than `index.css`, substitute that path in the `git add`.)

- [ ] **Step 5: Confirm WIP untouched**

Run: `git status --porcelain`
Expected: only `apps/frontend/src/MobileApp.tsx`, `apps/frontend/src/pages/Camera.tsx`, `apps/frontend/src/pages/SubmitForm.tsx` remain modified-but-uncommitted; nothing of theirs was swept in.

---

### Task 9: Activity drawer — `reopened` event kind

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx` (`Filter` ~line 28; counter init ~line 64; `ACTION_META` ~line 36; filter-pill list ~line 137; `summary` chain ~line 247)

- [ ] **Step 1: Add `reopened` to the Filter type**

Change line 28:

```typescript
type Filter = 'all' | 'created' | 'status' | 'edited' | 'priced' | 'transferred' | 'received';
```

to:

```typescript
type Filter = 'all' | 'created' | 'status' | 'edited' | 'priced' | 'transferred' | 'received' | 'reopened';
```

- [ ] **Step 2: Add to the counter init (~line 64)**

Change:

```typescript
    const c: Record<string, number> = { all: 0, created: 0, status: 0, edited: 0, priced: 0, transferred: 0, received: 0 };
```

to:

```typescript
    const c: Record<string, number> = { all: 0, created: 0, status: 0, edited: 0, priced: 0, transferred: 0, received: 0, reopened: 0 };
```

- [ ] **Step 3: Add the `reopened` ACTION_META entry**

After the `received:` line (~line 36):

```typescript
  received:    { icon: 'check', label: 'Received',    dot: 'var(--pos)' },
  reopened:    { icon: 'refresh', label: 'Re-opened',  dot: 'var(--warn)' },
```

- [ ] **Step 4: Add to the filter-pill array (~line 137)**

Change:

```typescript
            {(['all', 'created', 'status', 'edited', 'priced', 'transferred', 'received'] as Filter[]).map(f => (
```

to:

```typescript
            {(['all', 'created', 'status', 'edited', 'priced', 'transferred', 'received', 'reopened'] as Filter[]).map(f => (
```

- [ ] **Step 5: Add the summary label (~line 247)**

Change:

```typescript
    : event.kind === 'received'    ? 'Received'
```

to:

```typescript
    : event.kind === 'received'    ? 'Received'
    : event.kind === 'reopened'    ? 'Re-opened'
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: zero errors (pre-existing WIP-file errors, if any, are not this task's concern).

```bash
git add apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx
git commit -m "feat(frontend): show 'reopened' events in the activity drawer"
```

---

### Final verification

- [ ] **Backend full suite:** `pnpm --filter recycle-erp-backend test` → all PASS incl. `transfer-orders.test.ts`; `transfers.test.ts` is gone.
- [ ] **Frontend:** `pnpm --filter recycle-erp-frontend test && pnpm -r run typecheck && pnpm --filter recycle-erp-frontend build` → route tests PASS (path unchanged), no type errors in feature files, build OK.
- [ ] **WIP intact:** `git status --porcelain` shows only the 3 pre-existing WIP files modified, none swept into any commit.
- [ ] **Manual smoke (optional, `pnpm dev`):** as manager, transfer items → a `TO-<n>` order appears under Pending on /transfers; Confirm received → moves to Received (status filter), items become `Done`; Re-open a Received order → back to Pending, items `In Transit` (and blocked with a clear toast if an item is on a sell order); Export CSV downloads `transfer-TO-<n>.csv`; Print manifest opens a clean packing list via the browser print dialog; the activity drawer shows transferred / received / reopened events.
```
