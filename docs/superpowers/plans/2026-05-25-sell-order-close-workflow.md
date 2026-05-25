# Sell Order Close Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Closed` terminal status to sell orders so a manager can abort an in-flight deal (Draft / Shipped / Awaiting payment) with a required reason; soft-committed inventory frees implicitly; reopen returns the order to Draft.

**Architecture:** Single migration adds `'Closed'` to the `sell_orders.status` CHECK, a `sell_order_close_reasons` lookup table, and a `close_reason_id` column. The existing `POST /api/sell-orders/:id/status` handler grows into a transition-map guard and a conditional reason / reopen-note check. Inventory release is implicit — the soft-commit query at `sellOrders.ts:53` widens from `status <> 'Done'` to `status NOT IN ('Done','Closed')`. Frontend gets a new `CloseSellOrderDialog`, a Reopen button, and a `Closed` chip in the SO list.

**Tech Stack:** Postgres 16, Hono (Node), TypeScript, React (Vite), `postgres` (postgres.js), Vitest integration tests against real Postgres.

**Spec:** `docs/superpowers/specs/2026-05-25-sell-order-close-workflow-design.md`

---

## File Structure

| File | Role | Action |
|---|---|---|
| `apps/backend/migrations/0053_sell_order_close.sql` | CHECK constraint widen + lookup table + denormalized column | Create |
| `apps/backend/scripts/seed.mjs` | Seed `'Closed'` status row + 5 reason rows | Modify |
| `apps/backend/src/routes/lookups.ts` | Expose `closeReasons` in `/api/lookups` | Modify |
| `apps/backend/src/services/sellOrderAudit.ts` | Add `'closed'` / `'reopened'` to `SellOrderEventKind` union | Modify |
| `apps/backend/src/routes/sellOrders.ts` | Transition map, close + reopen branches, inventory-release filter | Modify |
| `apps/backend/tests/sellOrders-close.test.ts` | Integration tests for the close + reopen workflow | Create |
| `apps/frontend/src/lib/lookups.ts` (or wherever the lookups hook lives) | Add `closeReasons` to the lookup payload type | Modify |
| `apps/frontend/src/pages/desktop/CloseSellOrderDialog.tsx` | Modal: reason picker + note + optional attachments | Create |
| `apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx` | Close button (3 statuses), Reopen button (Closed), disable edits when Closed | Modify |
| `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` | Status union + `'Closed'` filter chip + edit-pencil visibility | Modify |

Each backend change is one focused commit. Frontend bundles dialog + buttons + chip + filter as one commit because the type union change forces the touch points in lockstep.

---

## Task 1: Migration — extend status CHECK, add reasons table + FK column

**Files:**
- Create: `apps/backend/migrations/0053_sell_order_close.sql`

- [ ] **Step 1: Create the migration file with the exact content below**

```sql
-- Add 'Closed' to sell_orders.status. Closed is an off-ramp from Draft /
-- Shipped / Awaiting payment for deals that won't complete. Distinct from
-- Done: Done consumed inventory + fired commission; Closed just terminates
-- and releases the soft-commit so the inventory lines can be sold elsewhere.
--
-- See docs/superpowers/specs/2026-05-25-sell-order-close-workflow-design.md.

ALTER TABLE sell_orders DROP CONSTRAINT IF EXISTS sell_orders_status_check;
ALTER TABLE sell_orders ADD CONSTRAINT sell_orders_status_check
  CHECK (status IN ('Draft','Shipped','Awaiting payment','Done','Closed'));

-- Reason taxonomy. Lookup, not enum, so adding a reason is a seed change.
CREATE TABLE IF NOT EXISTS sell_order_close_reasons (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE
);

-- Denormalized current close-reason. Close is exactly-once per close-cycle
-- (reopen clears it). Joining to sell_order_events for the current reason
-- on every list/detail render is wasteful; the column carries it directly.
-- Reopen history still lives in sell_order_events.
ALTER TABLE sell_orders
  ADD COLUMN IF NOT EXISTS close_reason_id TEXT
    REFERENCES sell_order_close_reasons(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS sell_orders_close_reason_idx
  ON sell_orders(close_reason_id) WHERE close_reason_id IS NOT NULL;
```

- [ ] **Step 2: Apply the migration locally**

Run: `pnpm db:migrate`
Expected: `applied 0053_sell_order_close.sql` (or similar; check for no error and that the ledger advances).

- [ ] **Step 3: Verify schema by hand**

Run: `psql "$DATABASE_URL" -c "\d sell_orders" -c "\d sell_order_close_reasons"`
Expected: `sell_orders.status` CHECK lists all five values including `'Closed'`; `sell_orders.close_reason_id` column present with FK; `sell_order_close_reasons` table present with the four columns.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0053_sell_order_close.sql
git commit -m "feat(db): mig 0053 — add 'Closed' status + sell_order_close_reasons"
```

---

## Task 2: Seed — `'Closed'` status row + reason rows

**Files:**
- Modify: `apps/backend/scripts/seed.mjs` (around line 473 where `sell_order_statuses` is seeded)

- [ ] **Step 1: Find the existing `sell_order_statuses` seed block**

Run: `grep -n "sell_order_statuses\|sell_order_close_reasons" apps/backend/scripts/seed.mjs`
Expected: lines around 473–482 show the existing upsert block for `sell_order_statuses`. Confirm `sell_order_close_reasons` is not present yet.

- [ ] **Step 2: Extend the statuses array and add a new reasons upsert**

Locate the array literal that starts roughly:

```js
    { id: 'Draft',            short: 'Draft',        tone: 'muted', needsMeta: false },
    { id: 'Shipped',          short: 'Shipped',      tone: 'info',  needsMeta: true  },
    { id: 'Awaiting payment', short: 'Awaiting pay', tone: 'warn',  needsMeta: true  },
    { id: 'Done',             short: 'Done',         tone: 'pos',   needsMeta: true  },
```

Add a fifth entry on a new line after `Done`:

```js
    { id: 'Closed',           short: 'Closed',       tone: 'muted', needsMeta: true  },
```

Then, after the existing `INSERT INTO sell_order_statuses … ON CONFLICT … DO UPDATE` block finishes (find the closing `;` for that statement), insert this new block on the next blank line:

```js
  // Close-reason taxonomy. Surfaced in the CloseSellOrderDialog reason
  // dropdown. Lookup table so adding a reason is a seed change.
  {
    const reasons = [
      { id: 'customer_cancelled', label: 'Customer cancelled', position: 1 },
      { id: 'lost_deal',          label: 'Lost deal',          position: 2 },
      { id: 'returned',           label: 'Returned',           position: 3 },
      { id: 'duplicate',          label: 'Duplicate',          position: 4 },
      { id: 'other',              label: 'Other',              position: 5 },
    ];
    for (const r of reasons) {
      await sql`
        INSERT INTO sell_order_close_reasons (id, label, position, active)
        VALUES (${r.id}, ${r.label}, ${r.position}, TRUE)
        ON CONFLICT (id) DO UPDATE SET
          label    = EXCLUDED.label,
          position = EXCLUDED.position,
          active   = TRUE
      `;
    }
  }
```

Match the surrounding code style (the existing seed file uses `sql\`...\`` tagged templates inside async IIFE / functions; mirror whatever pattern the surrounding upserts use).

- [ ] **Step 3: Re-seed and verify**

Run: `pnpm db:seed`
Expected: completes without error.

Run: `psql "$DATABASE_URL" -c "SELECT id, label, position FROM sell_order_close_reasons ORDER BY position"`
Expected: five rows in the order `customer_cancelled, lost_deal, returned, duplicate, other`.

Run: `psql "$DATABASE_URL" -c "SELECT id, short_label, tone, needs_meta FROM sell_order_statuses WHERE id='Closed'"`
Expected: one row with `short_label='Closed', tone='muted', needs_meta=t`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/scripts/seed.mjs
git commit -m "feat(db): seed Closed status + 5 close-reason rows"
```

---

## Task 3: Audit event kind — broaden the union

**Files:**
- Modify: `apps/backend/src/services/sellOrderAudit.ts`

- [ ] **Step 1: Open the file**

Read: `apps/backend/src/services/sellOrderAudit.ts`. The current union is:

```ts
export type SellOrderEventKind =
  | 'archived'
  | 'unarchived';
```

- [ ] **Step 2: Add the two new kinds**

Edit the union to:

```ts
export type SellOrderEventKind =
  | 'archived'
  | 'unarchived'
  | 'closed'
  | 'reopened';
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: passes (the union expansion alone has no other call sites that need updating yet).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/services/sellOrderAudit.ts
git commit -m "feat(be): add 'closed'/'reopened' to SellOrderEventKind"
```

---

## Task 4: Lookups endpoint — expose `closeReasons`

**Files:**
- Modify: `apps/backend/src/routes/lookups.ts`

- [ ] **Step 1: Add the SELECT to the Promise.all and the response field**

Open `apps/backend/src/routes/lookups.ts`. The current handler runs four parallel SELECTs into `[catalogRows, sourceRows, statusRows, categoryRows]`. Add a fifth.

Change the `Promise.all` to:

```ts
  const [catalogRows, sourceRows, statusRows, categoryRows, closeReasonRows] = await Promise.all([
    sql`
      SELECT "group", value
      FROM catalog_options
      WHERE active = TRUE
      ORDER BY "group", position, value
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
      SELECT id, label, icon, enabled, default_margin::float AS default_margin, position
      FROM categories
      ORDER BY position
    `,
    sql`
      SELECT id, label
      FROM sell_order_close_reasons
      WHERE active = TRUE
      ORDER BY position, label
    `,
  ]);
```

Then add to the response JSON (inside the existing `return c.json({ … })`):

```ts
    closeReasons: closeReasonRows.map(r => ({
      id: r.id as string,
      label: r.label as string,
    })),
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: passes.

- [ ] **Step 3: Smoke-test the endpoint**

Run: `pnpm dev` (keep it running in a separate terminal — backend listens on :8787)
Run: `curl -s -b /tmp/cookies.txt -c /tmp/cookies.txt -H 'Content-Type: application/json' -d '{"email":"alex@recycleservers.io","password":"demo"}' http://localhost:8787/api/auth/login >/dev/null`
Run: `curl -s -b /tmp/cookies.txt http://localhost:8787/api/lookups | jq '.closeReasons'`
Expected: JSON array with 5 entries, ids `customer_cancelled` … `other`, in position order.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/lookups.ts
git commit -m "feat(be): expose closeReasons in /api/lookups"
```

---

## Task 5: Write failing backend tests for the close workflow

**Files:**
- Create: `apps/backend/tests/sellOrders-close.test.ts`

- [ ] **Step 1: Create the test file with the cases below**

The file mirrors `apps/backend/tests/sell-orders.test.ts` layout (vitest, real Postgres via `resetDb()`, `loginAs(ALEX)`, `freeSellableLine`). Use the same helpers; do not invent new ones.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  if (r.status !== 200 || !r.body.items?.length) throw new Error('no customers in seed');
  return r.body.items[0].id;
}

async function createDraftSellOrder(token: string): Promise<{ id: string; lineId: string }> {
  const line = await freeSellableLine(token);
  const customerId = await firstCustomerId(token);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId,
      lines: [{
        inventoryId: line.id, category: 'RAM', label: 'Sample',
        partNumber: 'PN-1', qty: 1, unitPrice: line.sell_price,
        warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
      }],
    },
  });
  expect(r.status).toBe(201);
  return { id: r.body.id, lineId: line.id };
}

async function advanceTo(token: string, soId: string, to: string, note = 'note') {
  const r = await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to, note } });
  expect(r.status).toBe(200);
}

describe('POST /api/sell-orders/:id/status — Close', () => {
  beforeEach(async () => { await resetDb(); });

  it('Draft → Closed: succeeds and writes a closed event', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token,
      body: { to: 'Closed', closeReasonId: 'customer_cancelled', note: 'changed mind' },
    });
    expect(r.status).toBe(200);

    const sql = getTestDb();
    const order = (await sql`SELECT status, close_reason_id FROM sell_orders WHERE id = ${id}`)[0];
    expect(order.status).toBe('Closed');
    expect(order.close_reason_id).toBe('customer_cancelled');

    const ev = (await sql`
      SELECT kind, detail FROM sell_order_events
      WHERE sell_order_id = ${id} AND kind = 'closed'
    `)[0];
    expect(ev).toBeDefined();
    expect(ev.detail.reasonId).toBe('customer_cancelled');
    expect(ev.detail.note).toBe('changed mind');
    expect(ev.detail.fromStatus).toBe('Draft');
  });

  it('Shipped → Closed releases the soft-committed inventory line', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lineId } = await createDraftSellOrder(token);
    await advanceTo(token, id, 'Shipped', 'ship');

    // Before close: a second SO referencing the same line should be rejected.
    const customerId = await firstCustomerId(token);
    const blocked = await api('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: 1 }],
      },
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);

    // Close.
    const close = await api('POST', `/api/sell-orders/${id}/status`, {
      token,
      body: { to: 'Closed', closeReasonId: 'lost_deal', note: 'lost' },
    });
    expect(close.status).toBe(200);

    // After close: the same line should now be accepted.
    const ok = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: lineId, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: 1 }],
      },
    });
    expect(ok.status).toBe(201);
  });

  it('Awaiting payment → Closed: succeeds', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await advanceTo(token, id, 'Shipped', 'ship');
    await advanceTo(token, id, 'Awaiting payment', 'await');
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'returned', note: 'returned by customer' },
    });
    expect(r.status).toBe(200);
  });

  it('Done → Closed: 409 illegal transition', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await advanceTo(token, id, 'Shipped', 'ship');
    await advanceTo(token, id, 'Awaiting payment', 'await');
    await advanceTo(token, id, 'Done', 'paid');
    const r = await api<{ error: string }>('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'late' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/illegal transition/);
  });

  it('Close without closeReasonId: 400', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', note: 'no reason' },
    });
    expect(r.status).toBe(400);
  });

  it('Close with unknown closeReasonId: 400', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'made_up', note: 'note' },
    });
    expect(r.status).toBe(400);
  });

  it('Close without note: 400', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other' },
    });
    expect(r.status).toBe(400);
  });

  it('Closed → Shipped: 409 illegal transition', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'n' },
    });
    const r = await api<{ error: string }>('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', note: 'try' },
    });
    expect(r.status).toBe(409);
  });

  it('Closed → Draft (reopen): clears reason, writes reopened event, can re-advance', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'oops' },
    });
    const reopen = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Draft', note: 'customer came back' },
    });
    expect(reopen.status).toBe(200);

    const sql = getTestDb();
    const order = (await sql`SELECT status, close_reason_id FROM sell_orders WHERE id = ${id}`)[0];
    expect(order.status).toBe('Draft');
    expect(order.close_reason_id).toBeNull();

    const ev = (await sql`
      SELECT kind, detail FROM sell_order_events
      WHERE sell_order_id = ${id} AND kind = 'reopened'
    `)[0];
    expect(ev).toBeDefined();
    expect(ev.detail.note).toBe('customer came back');
    expect(ev.detail.fromStatus).toBe('Closed');

    // Can re-advance like any Draft.
    await advanceTo(token, id, 'Shipped', 're-shipped');
  });

  it('Reopen without note: 400', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other', note: 'oops' },
    });
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Draft' },
    });
    expect(r.status).toBe(400);
  });

  it('Non-manager Close: 403', async () => {
    const { token: managerToken } = await loginAs(ALEX);
    const { id } = await createDraftSellOrder(managerToken);
    const { token: purchaserToken } = await loginAs(MARCUS);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token: purchaserToken,
      body: { to: 'Closed', closeReasonId: 'other', note: 'n' },
    });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test file — every case should fail (red)**

Run: `cd apps/backend && npx vitest run tests/sellOrders-close.test.ts`
Expected: file runs, multiple failures. The exact failure mode varies (400 instead of 200, or "unknown status: Closed", etc.). What matters is none of the new cases pass yet.

- [ ] **Step 3: Commit the red tests**

```bash
git add apps/backend/tests/sellOrders-close.test.ts
git commit -m "test(be): red tests for sell-order close + reopen workflow"
```

---

## Task 6: Backend handler — transition map, close, reopen, inventory release (green)

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts`

- [ ] **Step 1: Widen the soft-commit filter at line ~53**

Find inside `validateSellLines`:

```ts
        AND so.status <> 'Done'
```

Replace with:

```ts
        AND so.status NOT IN ('Done', 'Closed')
```

A Closed SO must not block a new sell order from claiming the same inventory line.

- [ ] **Step 2: Replace the `SELL_ORDER_FLOW` / `NEEDS_EVIDENCE` constants with the new transition map**

Find at line ~509:

```ts
const NEEDS_EVIDENCE = new Set(['Shipped', 'Awaiting payment', 'Done']);
const SELL_ORDER_FLOW = ['Draft', 'Shipped', 'Awaiting payment', 'Done'];
```

Replace with:

```ts
// Transition map is the single source of truth for what status changes
// are legal. Done has no outgoing edges (terminal happy path). Closed has
// exactly one outgoing edge (reopen → Draft). Adding a new status means
// editing this map + the CHECK constraint + the seed — no parallel guards
// elsewhere (see CLAUDE.md "Status guards").
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  Draft:               new Set(['Shipped', 'Closed']),
  Shipped:             new Set(['Awaiting payment', 'Closed']),
  'Awaiting payment':  new Set(['Done', 'Closed']),
  Done:                new Set([]),
  Closed:              new Set(['Draft']),
};
const KNOWN_STATUSES = new Set<string>([
  'Draft', 'Shipped', 'Awaiting payment', 'Done', 'Closed',
]);
// Statuses whose entry-edge requires a note OR attachments. The DB row
// sell_order_statuses.needs_meta tracks the same idea for per-status meta
// uploads (those routes look it up dynamically); this set governs the
// transition-time evidence gate.
const NEEDS_EVIDENCE = new Set(['Shipped', 'Awaiting payment', 'Done', 'Closed']);
```

- [ ] **Step 3: Rewrite the `POST /:id/status` handler body**

Replace the entire handler (currently `sellOrders.post('/:id/status', async (c) => { … })` at line ~512 — the block ending at line ~620) with:

```ts
sellOrders.post('/:id/status', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { to: string; note?: string; attachmentIds?: string[]; closeReasonId?: string }
    | null;
  if (!body?.to) return c.json({ error: 'to is required' }, 400);
  if (!KNOWN_STATUSES.has(body.to)) {
    return c.json({ error: `unknown status: ${body.to}` }, 400);
  }

  const hasNote = typeof body.note === 'string' && body.note.trim().length > 0;
  const hasFiles = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;

  // Static evidence gate (Shipped / Awaiting payment / Done / Closed).
  if (NEEDS_EVIDENCE.has(body.to) && !hasNote && !hasFiles) {
    return c.json({ error: 'note or attachments required for this status' }, 400);
  }
  // Close requires a structured reason in addition to evidence.
  if (body.to === 'Closed' && !body.closeReasonId) {
    return c.json({ error: 'closeReasonId is required to close' }, 400);
  }

  const sql = getDb(c.env);

  // Validate the close reason (active lookup row) outside the tx — it's a
  // read-only check against a slow-changing table; no need to hold the row
  // lock while the network resolves the lookup.
  if (body.to === 'Closed') {
    const r = await sql<{ ok: boolean }[]>`
      SELECT TRUE AS ok FROM sell_order_close_reasons
      WHERE id = ${body.closeReasonId!} AND active = TRUE LIMIT 1
    `;
    if (r.length === 0) return c.json({ error: 'invalid closeReasonId' }, 400);
  }

  // Current-status read, lock check, transition guard, and conditional
  // reopen-note gate MUST all run inside the transaction under FOR UPDATE.
  // Reading status outside the tx let two concurrent Done submits (double
  // click / network retry) both pass and both consume stock.
  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'illegal'; from: string; to: string }
    | { kind: 'idempotent'; status: string }
    | { kind: 'reopenNeedsNote' }
    | { kind: 'done' };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx<{ status: string }[]>`
      SELECT status FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    if (cur.status === body.to) return { kind: 'idempotent', status: cur.status };

    const allowed = ALLOWED_TRANSITIONS[cur.status] ?? new Set<string>();
    if (!allowed.has(body.to)) {
      return { kind: 'illegal', from: cur.status, to: body.to };
    }

    // Reopen (Closed → Draft) needs a note. We deliberately keep this
    // *out* of the global NEEDS_EVIDENCE set: a fresh Draft creation
    // doesn't need a note, so the rule is "transitions *into* Draft from
    // Closed need a note", not "Draft is a needs-evidence status".
    if (cur.status === 'Closed' && body.to === 'Draft' && !hasNote) {
      return { kind: 'reopenNeedsNote' };
    }

    // Apply the status update + (for close) the denormalized reason; (for
    // reopen) clear the reason.
    if (body.to === 'Closed') {
      await tx`
        UPDATE sell_orders
           SET status = 'Closed',
               close_reason_id = ${body.closeReasonId!},
               updated_at = NOW()
         WHERE id = ${id}
      `;
    } else if (cur.status === 'Closed' && body.to === 'Draft') {
      await tx`
        UPDATE sell_orders
           SET status = 'Draft',
               close_reason_id = NULL,
               updated_at = NOW()
         WHERE id = ${id}
      `;
    } else {
      await tx`UPDATE sell_orders SET status = ${body.to}, updated_at = NOW() WHERE id = ${id}`;
    }

    // Evidence persistence (status_meta upsert) — fires for any transition
    // that supplied a note, which includes the new Closed entry and the
    // Closed→Draft reopen.
    if (hasNote || NEEDS_EVIDENCE.has(body.to)) {
      await tx`
        INSERT INTO sell_order_status_meta (sell_order_id, status, note, set_at, set_by)
        VALUES (${id}, ${body.to}, ${body.note ?? null}, NOW(), ${u.id})
        ON CONFLICT (sell_order_id, status) DO UPDATE SET
          note   = EXCLUDED.note,
          set_at = NOW(),
          set_by = EXCLUDED.set_by
      `;
    }

    // Audit-event writes for close + reopen. Done's audit story is the
    // inventory_events rows below; archive lives in its own handler.
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
    }

    if (body.to === 'Done') {
      // Done consumes stock. order_lines.qty carries CHECK (qty > 0) so a
      // sold-out line can't drop to 0 — instead it flips to status 'Sold'.
      // In-stock aggregates key off status, so a Sold line falls out
      // regardless of its retained qty. Partially-sold lines lose qty and
      // stay sellable. Aggregated by inventory_id so multiple lines hitting
      // the same source net out.
      const sold = await tx<{ line_id: string; remaining: number; sold: number }[]>`
        UPDATE order_lines ol
           SET qty    = CASE WHEN ol.qty - s.q <= 0 THEN ol.qty ELSE ol.qty - s.q END,
               status = CASE WHEN ol.qty - s.q <= 0 THEN 'Sold' ELSE ol.status END
          FROM (
            SELECT inventory_id, SUM(qty)::int AS q
            FROM sell_order_lines
            WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL
            GROUP BY inventory_id
          ) s
         WHERE s.inventory_id = ol.id
        RETURNING ol.id AS line_id,
                  CASE WHEN ol.status = 'Sold' THEN 0 ELSE ol.qty END AS remaining,
                  s.q AS sold
      `;
      for (const r of sold) {
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
          VALUES (${r.line_id}, ${u.id}, 'sold',
                  ${tx.json({ soldQty: r.sold, remainingQty: r.remaining, sellOrder: id })})
        `;
      }
      const submitters = await tx<{ user_id: string }[]>`
        SELECT DISTINCT o.user_id
        FROM sell_order_lines sol
        JOIN order_lines l ON l.id = sol.inventory_id
        JOIN orders o ON o.id = l.order_id
        WHERE sol.sell_order_id = ${id} AND sol.inventory_id IS NOT NULL
      `;
      for (const s of submitters) {
        await notify(tx, {
          userId: s.user_id,
          kind: 'payment_received',
          tone: 'pos',
          icon: 'cash',
          title: `Sell order ${id} closed`,
          body: 'Commission ready for review.',
        });
      }
    }
    return { kind: 'done' };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'illegal') {
    return c.json({ error: `illegal transition: ${outcome.from} → ${outcome.to}` }, 409);
  }
  if (outcome.kind === 'idempotent') return c.json({ ok: true, status: outcome.status });
  if (outcome.kind === 'reopenNeedsNote') {
    return c.json({ error: 'note required to reopen' }, 400);
  }
  return c.json({ ok: true, status: body.to });
});
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: passes.

- [ ] **Step 4: Run the close test file — every case should now pass (green)**

Run: `cd apps/backend && npx vitest run tests/sellOrders-close.test.ts`
Expected: all 11 tests pass.

- [ ] **Step 5: Run the pre-existing sell-orders test files to confirm no regression**

Run: `cd apps/backend && npx vitest run tests/sell-orders.test.ts tests/sell-done-race.test.ts tests/sell-done-line.test.ts tests/sell-attachment-mime.test.ts tests/sell-order-no-discount.test.ts`
Expected: all pre-existing sell-order tests still pass. If any fail, the new transition map or evidence gate has tightened something it shouldn't have — fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts
git commit -m "feat(be): sell-order close + reopen via transition map"
```

---

## Task 7: Frontend — extend lookups type and status union

**Files:**
- Modify: `apps/frontend/src/lib/lookups.ts` (or wherever the SPA's lookups payload type lives)
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` (status union, ~line 32 and ~line 97)
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx` (any local status union)

- [ ] **Step 1: Locate the lookups type**

Run: `grep -rn "sellOrderStatuses\|priceSources" apps/frontend/src/lib/ apps/frontend/src/`
The hook / type file that mirrors the `/api/lookups` response will appear. Identify the type for the payload object.

- [ ] **Step 2: Add `closeReasons` to the lookups type and any default**

In the lookups type definition, add:

```ts
closeReasons: { id: string; label: string }[];
```

If there's a default / empty value used while the fetch is in flight, add `closeReasons: []` to it.

- [ ] **Step 3: Add `'Closed'` to the SO status string union**

In `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` near line 32:

```ts
  status: 'Draft' | 'Shipped' | 'Awaiting payment' | 'Done';
```

Change to:

```ts
  status: 'Draft' | 'Shipped' | 'Awaiting payment' | 'Done' | 'Closed';
```

The detail-page type at line ~97 (`status: SellOrderSummary['status']`) inherits from the summary, so it picks up `'Closed'` automatically. Verify by grep:

Run: `grep -rn "'Draft' | 'Shipped'" apps/frontend/src/`
For each hit, widen the union to include `| 'Closed'`.

- [ ] **Step 4: Type-check the frontend**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: passes. If the compiler surfaces switch / map sites that need a `Closed` branch (e.g. `toneFor()`), add a `'Closed' → 'muted'` arm — though if `toneFor` reads from `sellOrderStatuses` (the lookup), no change is needed; the seed already carries the tone.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/
git commit -m "feat(fe): broaden SO status union and lookups type for Closed"
```

---

## Task 8: Frontend — `CloseSellOrderDialog` + Close + Reopen buttons + list chip

**Files:**
- Create: `apps/frontend/src/pages/desktop/CloseSellOrderDialog.tsx`
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx` (detail / edit page — add Close button, Reopen button, disable edits when Closed)
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` (filter chip row + edit-pencil visibility)

- [ ] **Step 1: Create `CloseSellOrderDialog.tsx`**

Read the existing `StatusChangeDialog` first (search `grep -rn "StatusChangeDialog" apps/frontend/src/pages/desktop/` to find its file) so the new dialog matches its style — same modal scaffold, escape-to-close, primary/secondary button layout, error rendering.

Create `apps/frontend/src/pages/desktop/CloseSellOrderDialog.tsx`:

```tsx
import { useState } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useLookups } from '../../lib/lookups'; // path may differ — match the existing hook import sites

type Props = {
  sellOrderId: string;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;            // parent re-fetches the order on success
};

export function CloseSellOrderDialog({ sellOrderId, open, onClose, onClosed }: Props) {
  const t = useT();
  const lookups = useLookups();
  const reasons = lookups.closeReasons ?? [];
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const canSubmit = reasonId !== '' && note.trim().length > 0 && !submitting;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean }>(`/api/sell-orders/${sellOrderId}/status`, {
        to: 'Closed', closeReasonId: reasonId, note: note.trim(),
      });
      if (!r.ok) throw new Error('close failed');
      onClosed();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{t('so.close.dialog.title') || 'Close sell order'}</h2>
        <label>
          {t('so.close.dialog.reasonLabel') || 'Reason'}
          <select value={reasonId} onChange={e => setReasonId(e.target.value)} disabled={submitting}>
            <option value="">—</option>
            {reasons.map(r => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </label>
        <label>
          {t('so.close.dialog.noteLabel') || 'Note'}
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder={t('so.close.dialog.notePlaceholder') || 'Why is this deal being closed?'}
            disabled={submitting}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={submitting}>{t('common.cancel') || 'Cancel'}</button>
          <button onClick={submit} disabled={!canSubmit} className="danger">
            {t('so.close.dialog.submit') || 'Close order'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Adjust the import paths (`api`, `useT`, `useLookups`) and CSS class names to match the conventions actually used by `StatusChangeDialog` in the same directory. If the existing dialog uses a different import pattern (e.g. `import { api } from '../../lib/api'` vs a named hook), follow that pattern verbatim — do **not** introduce a new style here.

- [ ] **Step 2: Wire the Close button into the SO detail page**

Open `apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx`. Near where the existing status-advance and Archive buttons live (search for `Archive` to find the toolbar / header strip), add a Close button visible when:

```ts
draft.status === 'Draft' || draft.status === 'Shipped' || draft.status === 'Awaiting payment'
```

And a Reopen button visible when `draft.status === 'Closed'`.

Code shape (drop into wherever the status-action cluster lives):

```tsx
const [closeOpen, setCloseOpen] = useState(false);
const [reopenOpen, setReopenOpen] = useState(false);

const canClose = ['Draft', 'Shipped', 'Awaiting payment'].includes(draft.status);
const canReopen = draft.status === 'Closed';
```

In the JSX:

```tsx
{canClose && (
  <button className="btn btn-muted" onClick={() => setCloseOpen(true)}>
    {t('so.close.button') || 'Close…'}
  </button>
)}
{canReopen && (
  <button className="btn btn-muted" onClick={() => setReopenOpen(true)}>
    {t('so.reopen.button') || 'Reopen…'}
  </button>
)}

<CloseSellOrderDialog
  sellOrderId={order.id}
  open={closeOpen}
  onClose={() => setCloseOpen(false)}
  onClosed={() => { /* trigger the same refresh the existing save uses */ }}
/>
{reopenOpen && <ReopenDialog
  sellOrderId={order.id}
  onClose={() => setReopenOpen(false)}
  onReopened={() => { /* same refresh */ }}
/>}
```

Implement `ReopenDialog` inline at the bottom of `DesktopSellOrderDraft.tsx` (it's a 30-line component — note + submit, no reason picker). If `DesktopSellOrderDraft.tsx` is already large, create a sibling `ReopenSellOrderDialog.tsx` instead. Body:

```tsx
function ReopenDialog({ sellOrderId, onClose, onReopened }: {
  sellOrderId: string; onClose: () => void; onReopened: () => void;
}) {
  const t = useT();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean }>(`/api/sell-orders/${sellOrderId}/status`, {
        to: 'Draft', note: note.trim(),
      });
      if (!r.ok) throw new Error('reopen failed');
      onReopened();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{t('so.reopen.dialog.title') || 'Reopen sell order'}</h2>
        <label>
          {t('so.reopen.dialog.noteLabel') || 'Why are you reopening?'}
          <textarea value={note} onChange={e => setNote(e.target.value)} disabled={submitting} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={submitting}>{t('common.cancel') || 'Cancel'}</button>
          <button onClick={submit} disabled={note.trim() === '' || submitting} className="primary">
            {t('so.reopen.dialog.submit') || 'Reopen'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

When status is `Closed`, also disable the existing edit affordances (line add/remove, customer change, status-advance picker). The existing code already disables these when `status === 'Done'`; broaden every such guard:

```ts
const locked = draft.status === 'Done' || draft.status === 'Closed';
```

…and use `locked` wherever `status === 'Done'` was the disable condition. Verify with:

Run: `grep -n "'Done'" apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx`
For each hit that gates edit-ability, widen to `=== 'Done' || === 'Closed'` (or replace with a shared `locked` boolean).

When displaying a Closed order, render the reason inline in the header strip. Use the order's `close_reason_id` (the GET `/api/sell-orders/:id` response — verify it's already included by reading the route response shape; if not, surface it in the detail handler):

```tsx
{draft.status === 'Closed' && order.closeReasonId && (
  <div className="status-strip muted">
    Closed — {reasons.find(r => r.id === order.closeReasonId)?.label ?? order.closeReasonId}
  </div>
)}
```

*Note for the implementer: verify the backend GET handler returns `closeReasonId` for the detail page. If it doesn't, add it to the SELECT and response mapping in the handler block around `apps/backend/src/routes/sellOrders.ts:136` (the `SELECT so.id, so.status, …` for detail) and to the response object at `apps/backend/src/routes/sellOrders.ts:190`. Add `close_reason_id` to the SELECT, then `closeReasonId: head.close_reason_id` to the response.*

- [ ] **Step 3: Add `Closed` to the list page filter and broaden the edit-pencil visibility**

Open `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`. The filter chip row currently renders chips for each status loaded from `sellOrderStatuses`. Since `Closed` is now in the lookup, no code change is needed for the chips themselves — the new chip appears automatically.

Verify the chip filter actually iterates over the lookup (not a hardcoded array). If hardcoded, replace with iteration over `lookups.sellOrderStatuses`.

Then the edit-pencil at line ~333:

```ts
{o.status !== 'Done' && (
  <button … />
)}
```

Change to:

```ts
{o.status !== 'Done' && o.status !== 'Closed' && (
  <button … />
)}
```

- [ ] **Step 4: Type-check + build**

Run: `pnpm --filter recycle-erp-frontend typecheck && pnpm --filter recycle-erp-frontend build`
Expected: both pass.

- [ ] **Step 5: Manual smoke test in the browser**

Run: `pnpm dev`

In the browser at `http://localhost:5173`:
1. Log in as alex.
2. Create a sell order → advance to Shipped.
3. Click Close, pick `Lost deal`, enter a note → submit. Verify chip turns to `Closed` and the header strip shows the reason.
4. Create another sell order using the same inventory line — should succeed (proves the soft-commit was released).
5. Open the closed order → click Reopen → enter "customer came back" → submit. Verify status returns to Draft and edit affordances unlock.
6. Advance the reopened order through Shipped → Awaiting payment → Done. Verify the Done flow still works end-to-end.

If any step fails, fix before committing.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/
git commit -m "feat(fe): SO close dialog, reopen, Closed chip + edit-pencil guard"
```

---

## Task 9: Final verification + push

- [ ] **Step 1: Run the full backend test suite to catch any tangential regressions**

Run: `cd apps/backend && npx vitest run`
Expected: all tests pass. Per the CLAUDE.md note, the per-file invocation is the reliable path; if you must run the full suite, the resetDb advisory lock should keep it stable.

- [ ] **Step 2: Run the frontend test suite**

Run: `pnpm --filter recycle-erp-frontend test`
Expected: all tests pass.

- [ ] **Step 3: Final git log review and push**

Run: `git log --oneline origin/main..HEAD`
Expected: 7 commits (mig, seed, audit kind, lookups, red tests, green handler, frontend).

Run: `git push origin main`
Expected: clean push.

---

## Notes for the implementer

- **Soft-commit release is implicit.** Do not write any per-line `UPDATE order_lines` when closing — the only change needed is the `so.status NOT IN ('Done','Closed')` filter in `validateSellLines` at `sellOrders.ts:53`. Closed lines were never `'Sold'` (only Done consumes), so there's nothing to un-do.
- **Reopen-to-Draft note requirement** is the one context-aware branch of the evidence gate. Do not add `'Draft'` to the global `NEEDS_EVIDENCE` set — that would break fresh Draft creation elsewhere.
- **Idempotency** (`cur.status === body.to`) takes precedence over the transition guard. A double-clicked Close request returns `{ ok: true, status: 'Closed' }` on the second hit, not a 409.
- **CLAUDE.md** says extend existing guards, not parallel ones. The transition map *is* the existing guard, just generalized — keep it the single source of truth.
- **Mobile shell** is intentionally untouched. SO is desktop-only today.
