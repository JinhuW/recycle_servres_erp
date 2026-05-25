# Sell-Order Audit / Change History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every state-changing operation on a sell order writes an event to
`sell_order_events`, and the sell-order detail page surfaces a chronological
History panel.

**Reconciliation note (2026-05-25):** The Close + Reopen feature
landed on main in parallel (commits `4dc9c7e`..`4118092`). It already
added:
- `closed` and `reopened` to `SellOrderEventKind`
- `closed` and `reopened` event writes inside `POST /:id/status` for
  those specific transitions
- The `ALLOWED_TRANSITIONS` map + `KNOWN_STATUSES` set that replaced
  the old `SELL_ORDER_FLOW` array
- Migrations 0053 + 0054 for the Closed status and structured close
  reasons.

Tasks 2, 6, 9, and 10 below carry "**Reconciliation:**" callouts
describing the resulting deltas. The overall shape is unchanged.

**Architecture:** Mirror the existing PO audit module
(`services/orderAudit.ts` + `components/OrderActivityLog.tsx`). Extend
`services/sellOrderAudit.ts` with new event kinds, lift the shared `diff()`
helper into a small `services/auditDiff.ts` consumed by both modules, wire
`writeSellOrderEvent` into every mutating SO endpoint inside the existing
`sql.begin()` transactions, expose `GET /api/sell-orders/:id/events`, and
render the timeline in a new `SellOrderHistory` component mounted on the
SO detail page.

**Tech Stack:** TypeScript, Hono on `@hono/node-server` (Node 22), Postgres 16
via `postgres.js`, React 18 + Vite. Tests are integration (vitest, real
Postgres, fork pool).

**Spec:** `docs/superpowers/specs/2026-05-25-sell-order-audit-history-design.md`

---

## File Map

**Created:**
- `apps/backend/src/services/auditDiff.ts` — shared `diff()` + `AuditChange` (lifted)
- `apps/backend/src/services/sellOrderLineMatch.ts` — line set matcher for PATCH
- `apps/backend/tests/sellOrders.events.test.ts` — integration tests
- `apps/frontend/src/components/SellOrderHistory.tsx` — timeline UI

**Modified:**
- `apps/backend/src/services/sellOrderAudit.ts` — add kinds, field lists
- `apps/backend/src/services/orderAudit.ts` — re-export from `auditDiff.ts`
- `apps/backend/src/routes/sellOrders.ts` — wire events into every handler
- `apps/backend/src/routes/vendorBids.ts` — wire `created` event in promotion
- `apps/frontend/src/lib/types.ts` — add `SellOrderEvent` / `SellOrderEventKind`
- `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` — mount History panel

---

## Task 1: Lift shared `diff()` + `AuditChange` into `services/auditDiff.ts`

**Why first:** Both `orderAudit.ts` and `sellOrderAudit.ts` need the
JSON-stable diff helper. Extracting it once means later tasks only import.

**Files:**
- Create: `apps/backend/src/services/auditDiff.ts`
- Modify: `apps/backend/src/services/orderAudit.ts:14, 63-77`

- [ ] **Step 1: Create the shared module**

`apps/backend/src/services/auditDiff.ts`:

```ts
// Shared diff helper used by services/orderAudit.ts (PO) and
// services/sellOrderAudit.ts (SO). JSON-stable inequality so Date|null
// and number|null compare correctly without coercing 0 to null.

export type AuditChange = { field: string; from: unknown; to: unknown };

export function diff<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T)[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const f of fields) {
    const a = before[f] ?? null;
    const b = after[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ field: f as string, from: a, to: b });
    }
  }
  return changes;
}
```

- [ ] **Step 2: Replace the inline copy in `orderAudit.ts`**

Modify `apps/backend/src/services/orderAudit.ts`:

Delete lines 14 (`export type AuditChange = ...`) and 63-77 (the `diff`
function body). Replace with a re-export at the top of the file (just
under the existing `import type { Sql, ... }`):

```ts
export { diff, type AuditChange } from './auditDiff';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS (no errors — `routes/orders.ts` already imports `diff`
and `AuditChange` by name from `orderAudit.ts`, and the re-export
preserves that surface).

- [ ] **Step 4: Run existing PO audit tests**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/advance-audit-events.test.ts`
Expected: PASS — pre-existing PO event tests must keep working.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/auditDiff.ts apps/backend/src/services/orderAudit.ts
git commit -m "refactor(be): lift diff helper into services/auditDiff.ts"
```

---

## Task 2: Extend `services/sellOrderAudit.ts` with kinds + field lists

**Reconciliation:** The union now starts at `archived | unarchived |
closed | reopened` (the close/reopen feature already added the latter
two). Keep all four — this task only *adds* the new kinds below.

**Files:**
- Modify: `apps/backend/src/services/sellOrderAudit.ts`

- [ ] **Step 1: Replace the file with the extended version**

Overwrite `apps/backend/src/services/sellOrderAudit.ts` with:

```ts
// SO audit-log helpers — parallel to services/orderAudit.ts (PO) but scoped to
// sell_orders + sell_order_events. PO and SO timelines are independent.
//
// All writes assume they are running inside the caller's transaction, so an
// audit row is committed only if the change it describes is also committed.

import type { Sql, TransactionSql } from 'postgres';
export { diff, type AuditChange } from './auditDiff';

export type SqlLike = Sql | TransactionSql;

export type SellOrderEventKind =
  | 'created'
  | 'status_changed'
  | 'line_added'
  | 'line_removed'
  | 'line_edited'
  | 'meta_changed'
  | 'status_meta_changed'
  | 'archived'
  | 'unarchived'
  | 'closed'
  | 'reopened';

// Header fields PATCH /api/sell-orders/:id may touch on the sell_orders row.
// Status is intentionally excluded — it moves through POST /:id/status which
// emits its own status_changed event.
export const META_FIELDS_SO = [
  'notes',
  'customer_id',
] as const;
export type MetaFieldSO = typeof META_FIELDS_SO[number];

// Per-line fields whose change we surface as line_edited. Excludes ids,
// position (reorder is not a meaningful event), and sell_order_id.
export const LINE_FIELDS_SO = [
  'qty',
  'unit_price',
  'condition',
  'category',
  'label',
  'sub_label',
  'part_number',
  'warehouse_id',
  'inventory_id',
] as const;
export type LineFieldSO = typeof LINE_FIELDS_SO[number];

export async function writeSellOrderEvent(
  tx: SqlLike,
  sellOrderId: string,
  actorId: string | null,
  kind: SellOrderEventKind,
  detail: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO sell_order_events (sell_order_id, actor_id, kind, detail)
    VALUES (${sellOrderId}, ${actorId}, ${kind}, ${tx.json(detail as never)})
  `;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS — existing callers in `routes/sellOrders.ts` already
pass `'archived' | 'unarchived' | 'closed' | 'reopened'`; all remain
in the union.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/services/sellOrderAudit.ts
git commit -m "feat(be): expand SellOrderEventKind + add SO field lists"
```

---

## Task 3: Wire `created` event into POST /api/sell-orders + start test file

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts:213-281`
- Create: `apps/backend/tests/sellOrders.events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/sellOrders.events.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

async function eventsOf(sellOrderId: string): Promise<Array<{ kind: string; detail: Record<string, unknown>; actor_id: string | null }>> {
  const sql = getTestDb();
  return await sql`
    SELECT kind, detail, actor_id FROM sell_order_events
    WHERE sell_order_id = ${sellOrderId}
    ORDER BY created_at ASC, id ASC
  ` as unknown as Array<{ kind: string; detail: Record<string, unknown>; actor_id: string | null }>;
}

describe('sell-order audit events', () => {
  beforeEach(async () => { await resetDb(); });

  it('POST /api/sell-orders emits one `created` event', async () => {
    const { token, user } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const r = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        notes: 'first order',
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Sample',
          partNumber: 'PN-1', qty: 1, unitPrice: line.sell_price,
          warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(r.status).toBe(201);

    const events = await eventsOf(r.body.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('created');
    expect(events[0].actor_id).toBe(user.id);
    expect(events[0].detail).toMatchObject({
      source: 'manager',
      lineCount: 1,
      customerId,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts`
Expected: FAIL — `expect(events).toHaveLength(1)` receives `[]`.

- [ ] **Step 3: Wire the `created` event into POST handler**

Modify `apps/backend/src/routes/sellOrders.ts` lines 253-274. Inside the
existing `sql.begin(async (tx) => ...)`, after the INSERTs of
`sell_orders` and `sell_order_lines`, BEFORE the closure returns, add:

```ts
    await writeSellOrderEvent(tx, nextId, u.id, 'created', {
      source: 'manager',
      status: 'Draft',
      lineCount: body.lines.length,
      customerId: body.customerId,
    });
```

The complete replacement region is the closure body. Insert the
`writeSellOrderEvent` call right after the `for` loop that INSERTs lines
(after the current line 273, before the closing `});` of `sql.begin`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts apps/backend/tests/sellOrders.events.test.ts
git commit -m "feat(be): emit created event on POST /api/sell-orders"
```

---

## Task 4: Wire `created` event into vendor-bid promotion

**Files:**
- Modify: `apps/backend/src/routes/vendorBids.ts:150-226`
- Modify: `apps/backend/tests/sellOrders.events.test.ts` (add case)

- [ ] **Step 1: Add the failing test case**

Append to the `describe` block in
`apps/backend/tests/sellOrders.events.test.ts`:

```ts
  it('vendor-bid promotion emits `created` with source: vendor_bid', async () => {
    const { token } = await loginAs(ALEX);
    const sql = getTestDb();

    // Find a seeded vendor bid that has an accepted line not yet promoted.
    const bidRow = (await sql`
      SELECT vb.id AS bid_id
      FROM vendor_bids vb
      JOIN vendor_bid_lines vbl ON vbl.bid_id = vb.id
      WHERE vbl.line_status = 'accepted'
        AND vbl.sell_order_id IS NULL
        AND vbl.accepted_qty > 0
      LIMIT 1
    `)[0] as { bid_id: string } | undefined;
    if (!bidRow) throw new Error('seed has no promotable vendor bid; expand seed.mjs');

    const r = await api<{ sellOrderId: string }>(
      'POST', `/api/vendor-bids/${bidRow.bid_id}/promote`, { token });
    expect(r.status).toBe(201);

    const events = await eventsOf(r.body.sellOrderId);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('created');
    expect(events[0].detail).toMatchObject({
      source: 'vendor_bid',
      vendorBidId: bidRow.bid_id,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts -t 'vendor-bid promotion'`
Expected: FAIL — either the seed lacks a promotable bid (handle by
expanding seed.mjs in this step if needed; consult the existing vendor
bid tests for the seed shape) OR `expect(events).toHaveLength(1)` is `[]`.

If the seed lacks a promotable bid, expand `apps/backend/scripts/seed.mjs`
to seed at least one `vendor_bid` with an `accepted` line that has
`sell_order_id IS NULL`. Look for the existing vendor_bids seeding block
and add one accepted-but-not-promoted bid alongside the existing fixtures.
Verify by re-running `resetDb()` (the test calls it in `beforeEach`).

- [ ] **Step 3: Wire `created` event into the promotion route**

Modify `apps/backend/src/routes/vendorBids.ts` at line 215 (immediately
after the `for` loop closes, before the `outcome = { code: 201, sellId }`
line). Add:

```ts
    await writeSellOrderEvent(tx, sellId, u.id, 'created', {
      source: 'vendor_bid',
      vendorBidId: id,
      status: 'Draft',
      lineCount: lines.length,
      customerId: head.customer_id,
    });
```

Add the import at the top of the file (alongside the existing imports):

```ts
import { writeSellOrderEvent } from '../services/sellOrderAudit';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts -t 'vendor-bid promotion'`
Expected: PASS.

- [ ] **Step 5: Run the full vendor-bid suite (regression)**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/vendor-bids`
Expected: PASS — promotion is the most likely place to regress.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/vendorBids.ts apps/backend/tests/sellOrders.events.test.ts apps/backend/scripts/seed.mjs
git commit -m "feat(be): emit created event when promoting a vendor bid"
```

(Drop `seed.mjs` from the `git add` if you didn't need to touch it.)

---

## Task 5: Wire `meta_changed` + line events into PATCH /api/sell-orders/:id

**Why this is the trickiest task:** PATCH does wholesale DELETE+INSERT on
`sell_order_lines`, so old line ids vanish. We need a matcher that
classifies before/after lines into added / removed / edited using a stable
key. Strategy: match inventory-backed lines by `inventory_id` (the
one-active-SO-per-line invariant makes this 1:1), and match manual lines
(no `inventoryId`) by deep-equal tuple — if a manual line in the new set
exactly equals one in the old set across all `LINE_FIELDS_SO`, treat as
unchanged (no event); otherwise the old gets a `line_removed` and the new
gets a `line_added`. Manual lines never produce `line_edited` events
because they have no stable identity for "edit".

**Files:**
- Create: `apps/backend/src/services/sellOrderLineMatch.ts`
- Modify: `apps/backend/src/routes/sellOrders.ts:299-387`
- Modify: `apps/backend/tests/sellOrders.events.test.ts` (add cases)

- [ ] **Step 1: Write failing test cases**

Append to `apps/backend/tests/sellOrders.events.test.ts`:

```ts
  it('PATCH that changes only `notes` emits one `meta_changed`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId, notes: 'before',
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token, body: { notes: 'after' },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind !== 'created');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('meta_changed');
    expect(events[0].detail).toMatchObject({
      changes: [{ field: 'notes', from: 'before', to: 'after' }],
    });
  });

  it('PATCH with identical values emits zero events', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId, notes: 'same',
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token, body: { notes: 'same' },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind !== 'created');
    expect(events).toHaveLength(0);
  });

  it('PATCH editing an inventory-backed line qty emits `line_edited`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 3); // need qty >= 3 so we can bump from 1 to 2
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token,
      body: {
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 2, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind !== 'created');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('line_edited');
    expect(events[0].detail).toMatchObject({
      inventoryId: line.id,
      changes: [{ field: 'qty', from: 1, to: 2 }],
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts`
Expected: the 3 new cases FAIL.

- [ ] **Step 3: Create the line-matcher module**

`apps/backend/src/services/sellOrderLineMatch.ts`:

```ts
// Match before/after sell-order line sets to classify into added/removed/edited.
//
// PATCH /api/sell-orders/:id replaces lines wholesale (DELETE + INSERT), so we
// cannot rely on row ids. Inventory-backed lines match by inventory_id (1:1 by
// the one-active-SO-per-line invariant). Manual lines (no inventory_id) match
// by deep-equal tuple across LINE_FIELDS_SO — if an exact tuple exists in both
// sets, the line is unchanged; otherwise it's an add or a remove. Manual lines
// never produce line_edited events because they have no stable identity.

import { diff, LINE_FIELDS_SO, type AuditChange } from './sellOrderAudit';

export type SOLineSnap = {
  inventory_id: string | null;
  qty: number;
  unit_price: number;
  condition: string | null;
  category: string;
  label: string;
  sub_label: string | null;
  part_number: string | null;
  warehouse_id: string | null;
};

export type LineDiff = {
  added: SOLineSnap[];
  removed: SOLineSnap[];
  edited: Array<{ inventoryId: string; changes: AuditChange[]; snapshot: SOLineSnap }>;
};

function tupleKey(l: SOLineSnap): string {
  return JSON.stringify([l.qty, l.unit_price, l.condition, l.category,
    l.label, l.sub_label, l.part_number, l.warehouse_id]);
}

export function diffSellOrderLines(before: SOLineSnap[], after: SOLineSnap[]): LineDiff {
  const beforeInv = new Map<string, SOLineSnap>();
  const afterInv  = new Map<string, SOLineSnap>();
  const beforeManual: SOLineSnap[] = [];
  const afterManual:  SOLineSnap[] = [];

  for (const l of before) {
    if (l.inventory_id) beforeInv.set(l.inventory_id, l);
    else beforeManual.push(l);
  }
  for (const l of after) {
    if (l.inventory_id) afterInv.set(l.inventory_id, l);
    else afterManual.push(l);
  }

  const added: SOLineSnap[] = [];
  const removed: SOLineSnap[] = [];
  const edited: LineDiff['edited'] = [];

  // Inventory-backed: 3-way split by inventory_id.
  for (const [invId, oldLine] of beforeInv) {
    const newLine = afterInv.get(invId);
    if (!newLine) { removed.push(oldLine); continue; }
    const changes = diff(oldLine as unknown as Record<string, unknown>,
                        newLine as unknown as Record<string, unknown>,
                        LINE_FIELDS_SO);
    if (changes.length > 0) edited.push({ inventoryId: invId, changes, snapshot: newLine });
  }
  for (const [invId, newLine] of afterInv) {
    if (!beforeInv.has(invId)) added.push(newLine);
  }

  // Manual: deep-equal tuple match. Multi-set semantics so duplicates
  // (two identical manual lines on the same order) are handled correctly.
  const beforeBuckets = new Map<string, SOLineSnap[]>();
  for (const l of beforeManual) {
    const k = tupleKey(l);
    const bucket = beforeBuckets.get(k);
    if (bucket) bucket.push(l); else beforeBuckets.set(k, [l]);
  }
  for (const l of afterManual) {
    const k = tupleKey(l);
    const bucket = beforeBuckets.get(k);
    if (bucket && bucket.length > 0) { bucket.pop(); continue; }
    added.push(l);
  }
  for (const bucket of beforeBuckets.values()) {
    for (const l of bucket) removed.push(l);
  }

  return { added, removed, edited };
}
```

- [ ] **Step 4: Wire diff + event emission into PATCH handler**

Modify `apps/backend/src/routes/sellOrders.ts`. At the top, add to the
existing imports:

```ts
import {
  writeSellOrderEvent, diff, META_FIELDS_SO, type AuditChange,
} from '../services/sellOrderAudit';
import { diffSellOrderLines, type SOLineSnap } from '../services/sellOrderLineMatch';
```

Replace the entire PATCH handler body (lines 299-387). The new body
captures the row+lines BEFORE the update, applies the existing UPDATE/
DELETE+INSERT, then emits diff events inside the same `sql.begin`:

```ts
sellOrders.patch('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { status?: string; notes?: string;
        customerId?: string; lines?: LineIn[] }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  if (body.status !== undefined) {
    return c.json({ error: 'Use POST /:id/status to change status' }, 400);
  }
  const sql = getDb(c.env);

  const editsStructure = body.customerId !== undefined || body.lines !== undefined;

  const current = (await sql<{ status: string }[]>`
    SELECT status FROM sell_orders WHERE id = ${id} LIMIT 1
  `)[0];
  if (!current) return c.json({ error: 'Not found' }, 404);

  if (editsStructure && current.status === 'Done') {
    return c.json({ error: 'cannot edit lines or customer of a Done order' }, 409);
  }

  if (body.lines !== undefined && (!Array.isArray(body.lines) || body.lines.length === 0)) {
    return c.json({ error: 'at least one line required' }, 400);
  }
  if (Array.isArray(body.lines)) {
    for (const l of body.lines) {
      if (!Number.isInteger(l.qty) || l.qty <= 0) {
        return c.json({ error: 'qty must be a positive integer' }, 400);
      }
      if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
        return c.json({ error: 'unitPrice must be ≥ 0' }, 400);
      }
    }
  }

  type Outcome = { code: 400; msg: string } | { code: 200 };
  let outcome: Outcome = { code: 200 };
  await sql.begin(async (tx) => {
    // Snapshot BEFORE state for diffing.
    const beforeHead = (await tx<{ notes: string | null; customer_id: string }[]>`
      SELECT notes, customer_id FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    const beforeLines = body.lines !== undefined
      ? await tx<SOLineSnap[]>`
          SELECT inventory_id, qty, unit_price::float AS unit_price, condition,
                 category, label, sub_label, part_number, warehouse_id
          FROM sell_order_lines WHERE sell_order_id = ${id} ORDER BY position
        `
      : [];

    if (body.lines !== undefined) {
      const err = await validateSellLines(tx, body.lines, id);
      if (err) { outcome = { code: 400, msg: err }; return; }
    }
    await tx`
      UPDATE sell_orders SET
        notes       = COALESCE(${body.notes ?? null}, notes),
        customer_id = COALESCE(${body.customerId ?? null}, customer_id),
        updated_at  = NOW()
      WHERE id = ${id}
    `;
    if (body.lines !== undefined) {
      await tx`DELETE FROM sell_order_lines WHERE sell_order_id = ${id}`;
      for (let i = 0; i < body.lines.length; i++) {
        const l = body.lines[i];
        await tx`
          INSERT INTO sell_order_lines
            (sell_order_id, inventory_id, category, label, sub_label, part_number,
             qty, unit_price, warehouse_id, condition, position)
          VALUES
            (${id}, ${l.inventoryId ?? null}, ${l.category}, ${l.label},
             ${l.subLabel ?? null}, ${l.partNumber ?? null},
             ${l.qty}, ${l.unitPrice},
             ${l.warehouseId ?? null}, ${l.condition ?? null}, ${i})
        `;
      }
    }

    // Diff events — emitted only when something actually changed.
    const afterHead = (await tx<{ notes: string | null; customer_id: string }[]>`
      SELECT notes, customer_id FROM sell_orders WHERE id = ${id} LIMIT 1
    `)[0];
    const metaChanges: AuditChange[] = diff(
      beforeHead as unknown as Record<string, unknown>,
      afterHead as unknown as Record<string, unknown>,
      META_FIELDS_SO,
    );
    if (metaChanges.length > 0) {
      await writeSellOrderEvent(tx, id, u.id, 'meta_changed', { changes: metaChanges });
    }

    if (body.lines !== undefined) {
      const afterLines = await tx<SOLineSnap[]>`
        SELECT inventory_id, qty, unit_price::float AS unit_price, condition,
               category, label, sub_label, part_number, warehouse_id
        FROM sell_order_lines WHERE sell_order_id = ${id} ORDER BY position
      `;
      const lineDiff = diffSellOrderLines(beforeLines as unknown as SOLineSnap[],
                                          afterLines as unknown as SOLineSnap[]);
      for (const snap of lineDiff.added) {
        await writeSellOrderEvent(tx, id, u.id, 'line_added', { snapshot: snap });
      }
      for (const snap of lineDiff.removed) {
        await writeSellOrderEvent(tx, id, u.id, 'line_removed', { snapshot: snap });
      }
      for (const e of lineDiff.edited) {
        await writeSellOrderEvent(tx, id, u.id, 'line_edited', {
          inventoryId: e.inventoryId, changes: e.changes, snapshot: e.snapshot,
        });
      }
    }
  });
  if (outcome.code !== 200) {
    const e = outcome as { code: 400; msg: string };
    return c.json({ error: e.msg }, 400);
  }
  return c.json({ ok: true });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts`
Expected: all PATCH cases PASS, plus the existing `created` cases still PASS.

- [ ] **Step 6: Run the full sell-order suite (regression)**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sell-orders.test.ts tests/sell-attachment-mime.test.ts tests/sell-done-line.test.ts tests/sell-done-race.test.ts tests/sell-order-no-discount.test.ts`
Expected: PASS — the PATCH handler is heavily exercised; this catches regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/services/sellOrderLineMatch.ts apps/backend/src/routes/sellOrders.ts apps/backend/tests/sellOrders.events.test.ts
git commit -m "feat(be): emit meta_changed + line events on PATCH /api/sell-orders/:id"
```

---

## Task 6: Wire `status_changed` event into POST /api/sell-orders/:id/status

**Reconciliation:** The handler already emits `closed` (for any
transition into `Closed`) and `reopened` (for `Closed → Draft`). To
avoid double-events for those two transitions, this task emits
`status_changed` only when neither dedicated kind applies — i.e., for
transitions like `Draft → Shipped`, `Shipped → Awaiting payment`,
`Awaiting payment → Done`. Close + reopen continue to be the
exclusive carriers of their own structured detail.

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts` (inside the `sql.begin`
  closure in the `POST /:id/status` handler — function starts around
  line 531; the closure starts at `await sql.begin(...)` around line 579)
- Modify: `apps/backend/tests/sellOrders.events.test.ts` (add case)

- [ ] **Step 1: Add failing test case**

Append to the events test file:

```ts
  it('status transition emits `status_changed` with from/to', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', note: 'shipped via UPS' },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind === 'status_changed');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ from: 'Draft', to: 'Shipped' });
  });

  it('Close transition emits `closed`, not `status_changed`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    // Pick any active close reason from the seed.
    const reason = (await getTestDb()`
      SELECT id FROM sell_order_close_reasons WHERE active = TRUE LIMIT 1
    `)[0] as { id: string } | undefined;
    if (!reason) throw new Error('seed lacks active close reason');

    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token,
      body: { to: 'Closed', note: 'customer dropped', closeReasonId: reason.id },
    });
    expect(r.status).toBe(200);

    const events = await eventsOf(id);
    expect(events.map(e => e.kind)).toEqual(['created', 'closed']);
  });

  it('idempotent status transition (same status twice) emits only one event', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 's' } });
    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 's' } });

    const events = (await eventsOf(id)).filter(e => e.kind === 'status_changed');
    expect(events).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts -t 'status'`
Expected: FAIL — `status_changed` events not emitted yet.

- [ ] **Step 3: Wire the event**

Modify `apps/backend/src/routes/sellOrders.ts`. Inside the `POST
/:id/status` handler's `sql.begin` closure, find the existing
`closed`/`reopened` event-emission block (the one that currently
reads `if (body.to === 'Closed') { await writeSellOrderEvent(... 'closed' ...)`
followed by `else if (cur.status === 'Closed' && body.to === 'Draft')`).
Add a final `else` branch that handles all other transitions:

```ts
    if (body.to === 'Closed') {
      await writeSellOrderEvent(tx, id, u.id, 'closed', {
        reasonId: body.closeReasonId!,
        note: body.note ?? null,
        fromStatus: cur.status,
      });
    } else if (cur.status === 'Closed' && body.to === 'Draft') {
      await writeSellOrderEvent(tx, id, u.id, 'reopened', {
        note: body.note ?? null,
        fromStatus: 'Closed',
      });
    } else {
      await writeSellOrderEvent(tx, id, u.id, 'status_changed', {
        from: cur.status,
        to: body.to,
      });
    }
```

Idempotent same-status calls already early-return with
`{ kind: 'idempotent' }` BEFORE entering this branch, so no event
fires for no-op transitions. The illegal-transition branch returns
`{ kind: 'illegal' }` earlier as well, so this code is reached only
for accepted, real transitions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts`
Expected: PASS (all cases so far).

- [ ] **Step 5: Run the full sell-order suite (regression)**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sell-orders.test.ts tests/sell-done-race.test.ts tests/sell-done-line.test.ts`
Expected: PASS — status transition is the most-tested path.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts apps/backend/tests/sellOrders.events.test.ts
git commit -m "feat(be): emit status_changed event on SO status transition"
```

---

## Task 7: Wire `status_meta_changed` events into status-meta endpoints

**Three endpoints need wrapping in `sql.begin` (they currently aren't):**
- `PUT  /:id/status-meta/:status`              — sellOrders.ts:396
- `POST /:id/status-meta/:status/attachments`  — sellOrders.ts:422
- `DELETE /:id/status-meta/:status/attachments/:attachmentId` — sellOrders.ts:477

The audit row must commit atomically with the underlying state change, so
each handler is rewritten to run its writes inside `sql.begin`.

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts:396-497`
- Modify: `apps/backend/tests/sellOrders.events.test.ts` (add cases)

- [ ] **Step 1: Add failing test cases**

Append to the events test file:

```ts
  it('PUT status-meta note emits `status_meta_changed`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    const r = await api('PUT', `/api/sell-orders/${id}/status-meta/Shipped`, {
      token, body: { note: 'tracking 1Z999' },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind === 'status_meta_changed');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({
      status: 'Shipped',
      field: 'note',
    });
  });

  it('POST status-meta attachment emits `status_meta_changed`', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;

    // Use the existing pdf fixture path used by sell-orders.test.ts.
    const r = await multipart(`/api/sell-orders/${id}/status-meta/Shipped/attachments`, {
      token,
      files: { file: { path: pdf, name: 'invoice.pdf', mime: 'application/pdf' } },
    });
    expect(r.status).toBe(200);

    const events = (await eventsOf(id)).filter(e => e.kind === 'status_meta_changed');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({
      status: 'Shipped',
      field: 'attachment_added',
      filename: 'invoice.pdf',
    });
  });
```

Also add the imports at the top of the test file:

```ts
import { multipart } from './helpers/app';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const pdf = join(__dirname, 'fixtures', 'invoice.pdf');
```

If `multipart` is already imported via the existing line in the file,
skip the duplicate.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts -t 'status-meta'`
Expected: FAIL — no events.

- [ ] **Step 3: Rewrite the PUT note handler**

Replace `apps/backend/src/routes/sellOrders.ts:396-419` with:

```ts
sellOrders.put('/:id/status-meta/:status', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const status = c.req.param('status');
  const body = (await c.req.json().catch(() => null)) as { note?: string | null } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const sql = getDb(c.env);
  const metaStatusSet = await loadMetaStatuses(sql);
  if (!metaStatusSet.has(status)) return c.json({ error: 'invalid status' }, 400);

  const exists = (await sql`SELECT 1 FROM sell_orders WHERE id = ${id} LIMIT 1`)[0];
  if (!exists) return c.json({ error: 'Not found' }, 404);

  const note = (body.note ?? '').trim() || null;
  await sql.begin(async (tx) => {
    const before = (await tx<{ note: string | null }[]>`
      SELECT note FROM sell_order_status_meta
      WHERE sell_order_id = ${id} AND status = ${status} LIMIT 1
    `)[0];
    await tx`
      INSERT INTO sell_order_status_meta (sell_order_id, status, note, set_by)
      VALUES (${id}, ${status}, ${note}, ${u.id})
      ON CONFLICT (sell_order_id, status)
      DO UPDATE SET note = EXCLUDED.note, set_at = NOW(), set_by = EXCLUDED.set_by
    `;
    const fromNote = before?.note ?? null;
    if (fromNote !== note) {
      await writeSellOrderEvent(tx, id, u.id, 'status_meta_changed', {
        status, field: 'note', from: fromNote, to: note,
      });
    }
  });
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Rewrite the POST attachment handler**

Replace `apps/backend/src/routes/sellOrders.ts:422-474` with:

```ts
sellOrders.post('/:id/status-meta/:status/attachments', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const status = c.req.param('status');

  const sql = getDb(c.env);
  const metaStatusSet = await loadMetaStatuses(sql);
  if (!metaStatusSet.has(status)) return c.json({ error: 'invalid status' }, 400);
  const exists = (await sql`SELECT 1 FROM sell_orders WHERE id = ${id} LIMIT 1`)[0];
  if (!exists) return c.json({ error: 'Not found' }, 404);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const file = form.get('file') as File | null;
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  if (!file.type || !allowedMime.has(file.type)) {
    return c.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, 415);
  }
  if (file.size > maxBytes) {
    return c.json({ error: `file too large (max ${maxBytes} bytes)` }, 413);
  }

  // R2 upload happens outside the transaction — it's the slow part, and a tx
  // open across it would hold a row lock for the whole upload. If the DB
  // INSERT below fails the uploaded object is orphaned in R2, same risk as
  // pre-audit code; r2.ts treats orphans as a separate concern.
  const uploaded = await uploadAttachment(c.env, file, `sell-orders/${id}/${status}`)
    .catch(e => { console.error('attachment upload', e); return null; });
  if (!uploaded) return c.json({ error: 'upload failed' }, 502);

  const row = await sql.begin(async (tx) => {
    const r = (await tx`
      INSERT INTO sell_order_status_attachments
        (sell_order_id, status, filename, size_bytes, mime_type, storage_key, delivery_url, uploaded_by)
      VALUES
        (${id}, ${status}, ${file.name}, ${file.size},
         ${file.type || 'application/octet-stream'},
         ${uploaded.storageKey}, ${uploaded.deliveryUrl}, ${u.id})
      RETURNING id, filename, size_bytes, mime_type, delivery_url, uploaded_at
    `)[0];
    await writeSellOrderEvent(tx, id, u.id, 'status_meta_changed', {
      status, field: 'attachment_added',
      attachmentId: r.id, filename: r.filename, size: r.size_bytes, mime: r.mime_type,
    });
    return r;
  });

  return c.json({
    attachment: {
      id: row.id,
      filename: row.filename,
      size: row.size_bytes,
      mime: row.mime_type,
      url: row.delivery_url,
      uploadedAt: row.uploaded_at,
    },
  });
});
```

- [ ] **Step 5: Rewrite the DELETE attachment handler**

Replace `apps/backend/src/routes/sellOrders.ts:477-497` with:

```ts
sellOrders.delete('/:id/status-meta/:status/attachments/:attachmentId', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const status = c.req.param('status');
  const attachmentId = c.req.param('attachmentId');

  const sql = getDb(c.env);
  const metaStatusSet = await loadMetaStatuses(sql);
  if (!metaStatusSet.has(status)) return c.json({ error: 'invalid status' }, 400);

  const removed = await sql.begin(async (tx) => {
    const row = (await tx`
      SELECT storage_key, filename FROM sell_order_status_attachments
      WHERE id = ${attachmentId} AND sell_order_id = ${id} AND status = ${status}
      LIMIT 1
    `)[0] as { storage_key: string; filename: string } | undefined;
    if (!row) return null;
    await tx`DELETE FROM sell_order_status_attachments WHERE id = ${attachmentId}`;
    await writeSellOrderEvent(tx, id, u.id, 'status_meta_changed', {
      status, field: 'attachment_removed',
      attachmentId, filename: row.filename,
    });
    return row;
  });

  if (!removed) return c.json({ error: 'Not found' }, 404);
  // R2 delete happens outside the tx — same rationale as upload: slow side-
  // effect on the network, kept out of the lock window. Best-effort.
  await deleteAttachment(c.env, removed.storage_key).catch(e => console.error('r2 delete', e));
  return c.json({ ok: true });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts`
Expected: PASS.

- [ ] **Step 7: Run regression suites**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sell-orders.test.ts tests/sell-attachment-mime.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts apps/backend/tests/sellOrders.events.test.ts
git commit -m "feat(be): emit status_meta_changed events for SO status notes/attachments"
```

---

## Task 8: Add `GET /api/sell-orders/:id/events` endpoint

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts` (add handler before `export default`)
- Modify: `apps/backend/tests/sellOrders.events.test.ts` (add cases)

- [ ] **Step 1: Add failing test cases**

Append to the events test file:

```ts
  it('GET /:id/events returns events in chronological order', async () => {
    const { token, user } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId, notes: 'first',
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });
    const id = create.body.id;
    await api('PATCH', `/api/sell-orders/${id}`, { token, body: { notes: 'second' } });
    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 's' } });

    const r = await api<{ events: Array<{ kind: string; actor: { id: string } | null; createdAt: string }> }>(
      'GET', `/api/sell-orders/${id}/events`, { token });
    expect(r.status).toBe(200);
    expect(r.body.events.map(e => e.kind)).toEqual([
      'created', 'meta_changed', 'status_changed',
    ]);
    expect(r.body.events[0].actor?.id).toBe(user.id);
  });

  it('GET /:id/events is forbidden for non-manager', async () => {
    const { token: managerTok } = await loginAs(ALEX);
    const line = await freeSellableLine(managerTok);
    const customerId = await firstCustomerId(managerTok);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: managerTok,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'X', partNumber: 'P', qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested' }],
      },
    });

    const { token: purchaserTok } = await loginAs(MARCUS);
    const r = await api('GET', `/api/sell-orders/${create.body.id}/events`, { token: purchaserTok });
    expect(r.status).toBe(403);
  });

  it('GET /:id/events returns 404 for missing order', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/sell-orders/SL-99999/events', { token });
    expect(r.status).toBe(404);
  });
```

Add to the test file's existing import:
```ts
import { loginAs, ALEX, MARCUS } from './helpers/auth';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts -t 'GET /:id/events'`
Expected: FAIL — endpoint doesn't exist.

- [ ] **Step 3: Add the handler**

Insert into `apps/backend/src/routes/sellOrders.ts` immediately before
the `export default sellOrders;` line:

```ts
// ── Audit timeline for a single sell order. Manager-only (sell-orders is
// manager-only throughout the route file).
sellOrders.get('/:id/events', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const exists = (await sql`SELECT 1 FROM sell_orders WHERE id = ${id} LIMIT 1`)[0];
  if (!exists) return c.json({ error: 'Not found' }, 404);

  const rows = await sql`
    SELECT e.id, e.kind, e.detail, e.created_at,
           act.id AS actor_id, act.name AS actor_name, act.initials AS actor_initials
    FROM sell_order_events e
    LEFT JOIN users act ON act.id = e.actor_id
    WHERE e.sell_order_id = ${id}
    ORDER BY e.created_at ASC, e.id ASC
  ` as Array<{
    id: string;
    kind: string;
    detail: Record<string, unknown>;
    created_at: string;
    actor_id: string | null;
    actor_name: string | null;
    actor_initials: string | null;
  }>;

  return c.json({
    events: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      detail: r.detail,
      createdAt: r.created_at,
      actor: r.actor_id
        ? { id: r.actor_id, name: r.actor_name ?? '', initials: r.actor_initials ?? '' }
        : null,
    })),
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sellOrders.events.test.ts`
Expected: PASS — all events cases.

- [ ] **Step 5: Backend typecheck + final regression**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS.

Run: `pnpm --filter recycle-erp-backend exec vitest run tests/sell-orders.test.ts tests/vendor-bids tests/sell-done-line.test.ts tests/sell-done-race.test.ts tests/sell-order-no-discount.test.ts tests/sell-attachment-mime.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts apps/backend/tests/sellOrders.events.test.ts
git commit -m "feat(be): add GET /api/sell-orders/:id/events endpoint"
```

---

## Task 9: Add FE types `SellOrderEvent` and `SellOrderEventKind`

**Files:**
- Modify: `apps/frontend/src/lib/types.ts`

- [ ] **Step 1: Read the existing types file**

Find the existing PO equivalent (`OrderEvent` / `OrderEventKind` /
`OrderEventChange`) in `apps/frontend/src/lib/types.ts`. The new SO
types live next to them.

- [ ] **Step 2: Append the new types**

Add to `apps/frontend/src/lib/types.ts`, right after the existing
`OrderEvent` definitions:

```ts
export type SellOrderEventKind =
  | 'created'
  | 'status_changed'
  | 'line_added'
  | 'line_removed'
  | 'line_edited'
  | 'meta_changed'
  | 'status_meta_changed'
  | 'archived'
  | 'unarchived'
  | 'closed'
  | 'reopened';

export type SellOrderEvent = {
  id: string;
  kind: SellOrderEventKind;
  detail: Record<string, unknown>;
  createdAt: string;
  actor: { id: string; name: string; initials: string } | null;
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS — types are additive, no consumers yet.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/types.ts
git commit -m "feat(fe): add SellOrderEvent + SellOrderEventKind types"
```

---

## Task 10: Create `SellOrderHistory.tsx` component

**Files:**
- Create: `apps/frontend/src/components/SellOrderHistory.tsx`

- [ ] **Step 1: Create the component**

`apps/frontend/src/components/SellOrderHistory.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { api } from '../lib/api';
import { handleFetchError } from '../lib/errorToast';
import { fmtDate, relTime, fmtUSD } from '../lib/format';
import { useT } from '../lib/i18n';
import type { SellOrderEvent } from '../lib/types';

type Props = {
  sellOrderId: string;
  // Bump to force a refresh after a save commits new events.
  refreshKey?: number;
};

const KIND_ICON: Record<SellOrderEvent['kind'], IconName> = {
  created:             'plus',
  status_changed:      'flag',
  line_added:          'plus',
  line_removed:        'trash',
  line_edited:         'edit',
  meta_changed:        'settings',
  status_meta_changed: 'paperclip',
  archived:            'box',
  unarchived:          'rotate',
  closed:              'x',
  reopened:            'rotate',
};

type Tone = 'pos' | 'info' | 'warn' | 'muted';
const KIND_TONE: Record<SellOrderEvent['kind'], Tone> = {
  created:             'pos',
  status_changed:      'info',
  line_added:          'pos',
  line_removed:        'warn',
  line_edited:         'info',
  meta_changed:        'muted',
  status_meta_changed: 'muted',
  archived:            'muted',
  unarchived:          'info',
  closed:              'warn',
  reopened:            'info',
};

const TONE_BG: Record<Tone, string> = {
  pos:   'var(--pos-soft)',
  info:  'var(--info-soft)',
  warn:  'var(--warn-soft)',
  muted: 'var(--bg-soft)',
};
const TONE_FG: Record<Tone, string> = {
  pos:   'var(--accent-strong)',
  info:  'oklch(0.45 0.13 250)',
  warn:  'oklch(0.45 0.13 75)',
  muted: 'var(--fg-subtle)',
};

const LIFECYCLE_LABEL: Record<string, string> = {
  Draft:               'Draft',
  Shipped:             'Shipped',
  'Awaiting payment':  'Awaiting payment',
  Done:                'Done',
  Closed:              'Closed',
};

const FIELD_LABEL: Record<string, string> = {
  notes:         'Notes',
  customer_id:   'Customer',
  qty:           'Qty',
  unit_price:    'Unit price',
  condition:     'Condition',
  category:      'Category',
  label:         'Label',
  sub_label:     'Sub-label',
  part_number:   'Part number',
  warehouse_id:  'Warehouse',
  inventory_id:  'Inventory line',
  note:          'Status note',
  attachment_added:   'Attachment added',
  attachment_removed: 'Attachment removed',
};

const MONEY_FIELDS = new Set(['unit_price']);

function renderValue(field: string, v: unknown, locale: string): string {
  if (v == null || v === '') return '—';
  if (MONEY_FIELDS.has(field) && typeof v === 'number') return fmtUSD(v, locale);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function summarize(event: SellOrderEvent, locale: string): React.ReactNode {
  const d = event.detail as Record<string, unknown>;
  switch (event.kind) {
    case 'created':
      return (
        <>
          Created (
          {(d.source === 'vendor_bid')
            ? <>from vendor bid <b>{String(d.vendorBidId ?? '')}</b></>
            : <>by {event.actor?.name ?? 'manager'}</>}
          ){typeof d.lineCount === 'number' ? <> · {d.lineCount} line{d.lineCount === 1 ? '' : 's'}</> : null}
        </>
      );
    case 'status_changed': {
      const from = LIFECYCLE_LABEL[String(d.from)] ?? String(d.from);
      const to   = LIFECYCLE_LABEL[String(d.to)]   ?? String(d.to);
      return <>Status: <b>{from}</b> → <b>{to}</b></>;
    }
    case 'meta_changed': {
      const changes = (d.changes as Array<{ field: string; from: unknown; to: unknown }>) ?? [];
      return (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {changes.map((c, i) => (
            <li key={i}>
              <b>{FIELD_LABEL[c.field] ?? c.field}</b>: {renderValue(c.field, c.from, locale)} → {renderValue(c.field, c.to, locale)}
            </li>
          ))}
        </ul>
      );
    }
    case 'line_added':
    case 'line_removed': {
      const snap = (d.snapshot as Record<string, unknown>) ?? {};
      const verb = event.kind === 'line_added' ? 'Added line' : 'Removed line';
      return (
        <>
          {verb}: <b>{String(snap.label ?? '—')}</b>
          {snap.qty != null ? <> · qty {String(snap.qty)}</> : null}
          {snap.unit_price != null && typeof snap.unit_price === 'number'
            ? <> · {fmtUSD(snap.unit_price, locale)}</>
            : null}
        </>
      );
    }
    case 'line_edited': {
      const changes = (d.changes as Array<{ field: string; from: unknown; to: unknown }>) ?? [];
      const invId = String(d.inventoryId ?? '');
      return (
        <>
          <div>Edited line {invId ? <code>{invId}</code> : null}</div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {changes.map((c, i) => (
              <li key={i}>
                <b>{FIELD_LABEL[c.field] ?? c.field}</b>: {renderValue(c.field, c.from, locale)} → {renderValue(c.field, c.to, locale)}
              </li>
            ))}
          </ul>
        </>
      );
    }
    case 'status_meta_changed': {
      const status = LIFECYCLE_LABEL[String(d.status)] ?? String(d.status);
      const field  = String(d.field);
      const label  = FIELD_LABEL[field] ?? field;
      if (field === 'note') {
        return <>{label} on <b>{status}</b>: {renderValue('note', d.to, locale)}</>;
      }
      // attachment_added / attachment_removed
      return <>{label} on <b>{status}</b>: {String(d.filename ?? '')}</>;
    }
    case 'archived':   return <>Archived</>;
    case 'unarchived': return <>Unarchived</>;
    case 'closed': {
      const note = d.note ? <> · "{String(d.note)}"</> : null;
      return <>Closed (reason: <code>{String(d.reasonId ?? '')}</code>){note}</>;
    }
    case 'reopened': {
      const note = d.note ? <> · "{String(d.note)}"</> : null;
      return <>Reopened{note}</>;
    }
  }
}

export function SellOrderHistory({ sellOrderId, refreshKey }: Props) {
  const t = useT();
  const locale = t('__locale__', 'en');
  const [events, setEvents] = useState<SellOrderEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ events: SellOrderEvent[] }>(`/api/sell-orders/${sellOrderId}/events`)
      .then(r => { if (!cancelled) setEvents(r.events); })
      .catch(e => handleFetchError(e));
    return () => { cancelled = true; };
  }, [sellOrderId, refreshKey]);

  if (events === null) return <div style={{ color: 'var(--fg-subtle)' }}>Loading…</div>;
  if (events.length === 0) return <div style={{ color: 'var(--fg-subtle)' }}>No activity yet.</div>;

  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
      {events.map(e => {
        const tone = KIND_TONE[e.kind];
        return (
          <li key={e.id} style={{ display: 'grid', gridTemplateColumns: '32px 1fr auto', gap: 12, alignItems: 'start' }}>
            <span style={{
              width: 32, height: 32, borderRadius: '50%',
              background: TONE_BG[tone], color: TONE_FG[tone],
              display: 'grid', placeItems: 'center',
            }}>
              <Icon name={KIND_ICON[e.kind]} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div>{summarize(e, locale)}</div>
              {e.actor ? (
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                  by {e.actor.name}
                </div>
              ) : null}
            </div>
            <time title={fmtDate(e.createdAt, locale)} style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {relTime(e.createdAt, locale)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS. If imports like `Icon`, `IconName`, `api.get`,
`handleFetchError`, `fmtDate`, `relTime`, `fmtUSD`, `useT` do not match
the existing `OrderActivityLog.tsx` shape, adjust them to mirror that
file's imports exactly (it's the closest twin and known-correct).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/components/SellOrderHistory.tsx
git commit -m "feat(fe): add SellOrderHistory timeline component"
```

---

## Task 11: Mount `<SellOrderHistory>` in `SellOrderDetail`

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx:376-...` (the `SellOrderDetail` subcomponent)

- [ ] **Step 1: Add the import**

In `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`, alongside
the existing component imports near the top:

```ts
import { SellOrderHistory } from '../../components/SellOrderHistory';
```

- [ ] **Step 2: Add a `refreshKey` state inside `SellOrderDetail`**

Find the `SellOrderDetail` function (starts at line 376). Near the
existing `useState` hooks at the top of the function body, add:

```ts
const [historyKey, setHistoryKey] = useState(0);
```

- [ ] **Step 3: Bump the key after every save**

Find every place inside `SellOrderDetail` that mutates the order (saves
the edit form, posts status, attaches/removes status-meta files). After
each successful mutation (typically after `api.post(...)` / `api.patch(...)`
inside a `.then(...)` or `await`), call `setHistoryKey(k => k + 1)`.

These mutation points are easy to find by grepping inside the function
for `api.post`, `api.patch`, `api.put`, `api.delete`. There are five or
six call sites. Add the `setHistoryKey(k => k + 1)` immediately after
each successful response. Do this conservatively — adding it after a
no-op call is harmless, but missing one means stale history.

- [ ] **Step 4: Render the panel at the bottom of the detail body**

At the end of `SellOrderDetail`'s JSX return — just before the closing
fragment / wrapper element of the detail body — add:

```tsx
<details open style={{ marginTop: 24 }}>
  <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '8px 0' }}>
    {t('sellOrders.history', 'History')}
  </summary>
  <div style={{ marginTop: 12 }}>
    <SellOrderHistory sellOrderId={order.id} refreshKey={historyKey} />
  </div>
</details>
```

(If `t` isn't already in scope inside `SellOrderDetail`, hard-code
`'History'` instead and skip the i18n call. Per CLAUDE.md, prefer
`useT()` — check the surrounding component for the existing translation
hook usage.)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS.

- [ ] **Step 6: Manual verification**

Start the dev server (`pnpm dev`), log in as `alex` (manager), open a
sell order's detail page:
1. Confirm the "History" section appears at the bottom, expanded.
2. Edit notes, save → a `Notes` row appears at the bottom of the timeline.
3. Change status to Shipped (with a note) → a `Status: Draft → Shipped`
   row and a `Status note on Shipped` row appear.
4. Add an attachment via the status dialog → an `Attachment added on
   Shipped` row appears.
5. Archive the order → an `Archived` row appears. Unarchive → row appears.

If any step doesn't show the new event, re-check step 3 (refreshKey
bumping) for that mutation.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSellOrders.tsx
git commit -m "feat(fe): mount SellOrderHistory panel on SO detail page"
```

---

## Task 12: Full-suite verification + cleanup

**Files:** none

- [ ] **Step 1: Backend typecheck**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS.

- [ ] **Step 2: Frontend typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS.

- [ ] **Step 3: Full backend test suite**

Run: `pnpm --filter recycle-erp-backend test`
Expected: PASS — all tests including `sellOrders.events.test.ts` and
the existing PO/SO suites.

- [ ] **Step 4: Frontend test suite**

Run: `pnpm --filter recycle-erp-frontend test`
Expected: PASS — no FE tests were added but regression on existing
suites is checked.

- [ ] **Step 5: Final commit (if any cleanup needed)**

If you discover any fix during verification, commit it as
`fix(audit): …` referring back to the task that introduced the bug.
Otherwise skip this step — there's nothing to do.

---

## Self-Review

**Spec coverage:**
- ✓ Event kinds: all spec kinds covered (Tasks 2-7).
- ✓ Detail JSON shapes: match spec table.
- ✓ Transactional guarantee: every `writeSellOrderEvent` call sits
  inside `sql.begin` (Tasks 3-7 explicitly).
- ✓ All mutation points wired (creation manager UI + vendor bid, PATCH,
  status transition, status-meta note + attach + detach, archive/unarchive
  already in place).
- ✓ Idempotency: PATCH-with-no-changes test (Task 5), same-status-twice
  test (Task 6).
- ✓ `META_FIELDS_SO` confirmed against the actual PATCH SET clause
  (`notes`, `customer_id` only — spec mentioned `payment` and
  `commission_rate` as expected but those columns do not exist on
  `sell_orders`; updated to match reality).
- ✓ GET endpoint with manager-only auth + 404.
- ✓ FE component + placement + refreshKey wiring.
- ✓ Tests cover authorization (manager OK, non-manager 403, missing 404).

**Spec deviation, intentional:** The spec said the SO timeline would
match PO's "owner OR manager" access. There is no owner concept on sell
orders (they're a manager-only surface throughout `routes/sellOrders.ts`
— every other handler in the file gates `u.role !== 'manager'`). The
plan's `GET /:id/events` follows that existing pattern: manager only.
Update the spec to reflect this if you'd like, or treat as a clarification.

**Placeholder scan:** no TBDs, no "implement later", no "similar to
Task N", all code is concrete.

**Type consistency:** `SellOrderEventKind` union matches between
`sellOrderAudit.ts` (Task 2) and `lib/types.ts` (Task 9). Detail shapes
in tests (`changes: [{ field, from, to }]`) match what handlers emit
in Tasks 5-7. `meta_changed`'s `changes` array uses `AuditChange` shape
shared between PO and SO via `auditDiff.ts`.
