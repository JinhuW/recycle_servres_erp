# Sell-Order Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let managers reversibly hide sell orders from the default list via a red Archive button inside the SO edit modal, gated by a type-the-SO-id confirmation dialog. Mirrors the PO archive (migration 0045) and adds an independent `sell_order_events` audit log.

**Architecture:** Add `sell_orders.archived_at TIMESTAMPTZ` for soft-hide, with a partial index covering the active-only hot path. Wrap archive/unarchive in `sql.begin` with a `FOR UPDATE` lock; emit an `archived` / `unarchived` row into a new `sell_order_events` table (append-only, parallel to `order_events` but with no PO linkage). Frontend adds a destructive button + type-to-confirm dialog inside the existing `SellOrderDetail` modal, plus a `Show archived` toggle on the list.

**Tech Stack:** Postgres 16, Hono on Node 22, postgres.js (`sql.begin` transactions), React 18, Vitest integration tests against a real database.

**Spec:** [docs/superpowers/specs/2026-05-22-sell-order-archive-design.md](../specs/2026-05-22-sell-order-archive-design.md)

---

## Pre-flight conventions (read once before starting)

- The user commits directly to `main`. Do not create feature branches. Each task ends with a commit.
- Backend tests are integration tests against `127.0.0.1:5432`. The Postgres container must be running (`docker compose up -d postgres`).
- Run a single test file with `pnpm --filter recycle-erp-backend test -- <substring>` — only the matching files run.
- Migrations run automatically on backend startup via `scripts/migrate.mjs`. After adding a migration file, restart the backend container or just run the test suite — the migrate step is part of test bootstrap.
- All mutating backend routes are wrapped in `csrfGuard` middleware. Tests use the `api()` helper from `tests/helpers/app.ts` which sets the `X-Requested-By` header automatically when given a `token`.
- Test user constants from `tests/helpers/auth.ts`: `ALEX` (manager), `MARCUS` (purchaser), `PRIYA` (purchaser).

---

## Task 1: Migration — `sell_orders.archived_at` + partial index

**Files:**
- Create: `apps/backend/migrations/0046_sell_orders_archived_at.sql`

- [ ] **Step 1: Write the migration**

Create `apps/backend/migrations/0046_sell_orders_archived_at.sql`:

```sql
-- Archive flag for sell orders. `archived_at` is a soft-hide timestamp:
-- the row stays intact (commission history, references, audit trail) but
-- drops out of the default list view. Reversible by setting back to NULL.
--
-- Distinct from DELETE: hard delete still only works on Draft (no audit
-- consequences). Archive is the manager's tool for tidying completed or
-- stalled sell orders at any non-Draft status.
--
-- The partial index covers the hot path: the list endpoint defaults to
-- "active only" (archived_at IS NULL), and most orders will be active.

ALTER TABLE sell_orders
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_sell_orders_active_created
  ON sell_orders (created_at DESC)
  WHERE archived_at IS NULL;
```

- [ ] **Step 2: Apply the migration**

Run: `docker exec recycle_pg psql -U recycle -d recycle_erp -c "\d sell_orders" | grep -i archived`

If the column isn't present yet, trigger the migrate step by restarting the backend or running:
`pnpm --filter recycle-erp-backend exec node scripts/migrate.mjs`

Expected: `archived_at | timestamp with time zone |` appears.

- [ ] **Step 3: Verify the partial index**

Run: `docker exec recycle_pg psql -U recycle -d recycle_erp -c "\d sell_orders" | grep idx_sell_orders_active_created`

Expected: `"idx_sell_orders_active_created" btree (created_at DESC) WHERE archived_at IS NULL`

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0046_sell_orders_archived_at.sql
git commit -m "feat(db): add sell_orders.archived_at for soft-hide archive"
```

---

## Task 2: Migration — `sell_order_events` table + append-only triggers

**Files:**
- Create: `apps/backend/migrations/0047_sell_order_events.sql`

- [ ] **Step 1: Write the migration**

Create `apps/backend/migrations/0047_sell_order_events.sql`:

```sql
-- Per-SO audit log. Independent of the PO order_events table — sell orders
-- have their own lifecycle (Draft → Shipped → Awaiting payment → Done) and
-- their own actors / commission story, so the audit timelines stay parallel
-- but unjoined.
--
-- This change only emits `archived` / `unarchived` events; other event
-- kinds (status_changed, line_added, meta_changed, etc.) are reserved for
-- a follow-up that wires the rest of routes/sellOrders.ts up to the table.
--
-- Append-only via BEFORE UPDATE/DELETE triggers — same pattern as 0037.

CREATE TABLE IF NOT EXISTS sell_order_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sell_order_id TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  actor_id      UUID REFERENCES users(id),
  kind          TEXT NOT NULL, -- archived | unarchived | (future kinds)
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sell_order_events_order_idx
  ON sell_order_events(sell_order_id, created_at DESC);

CREATE OR REPLACE FUNCTION sell_order_events_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sell_order_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sell_order_events_no_update ON sell_order_events;
DROP TRIGGER IF EXISTS sell_order_events_no_delete ON sell_order_events;
CREATE TRIGGER sell_order_events_no_update BEFORE UPDATE ON sell_order_events
  FOR EACH ROW EXECUTE FUNCTION sell_order_events_lock();
-- Note: BEFORE DELETE fires even on CASCADE. Sell orders can only be deleted
-- while in 'Draft' status (no events emitted yet), so the cascade never has
-- rows to delete in practice.
CREATE TRIGGER sell_order_events_no_delete BEFORE DELETE ON sell_order_events
  FOR EACH ROW EXECUTE FUNCTION sell_order_events_lock();
```

- [ ] **Step 2: Apply and verify**

Run: `pnpm --filter recycle-erp-backend exec node scripts/migrate.mjs`
Then: `docker exec recycle_pg psql -U recycle -d recycle_erp -c "\d sell_order_events"`

Expected: table listed with `id`, `sell_order_id`, `actor_id`, `kind`, `detail`, `created_at`, plus the two triggers.

- [ ] **Step 3: Verify the append-only guard fires**

Run:
```bash
docker exec recycle_pg psql -U recycle -d recycle_erp -c \
  "INSERT INTO sell_order_events (sell_order_id, kind) VALUES ('SO-NONEXIST', 'test')"
```
Expected: foreign-key violation (proving the FK works; no rows are written).

Then with a real SO id (skip if no fixtures handy — the test suite will cover this).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0047_sell_order_events.sql
git commit -m "feat(db): add append-only sell_order_events audit log"
```

---

## Task 3: Backend audit helper — `writeSellOrderEvent`

**Files:**
- Create: `apps/backend/src/services/sellOrderAudit.ts`

- [ ] **Step 1: Write the helper**

Mirrors `apps/backend/src/services/orderAudit.ts:79`. We keep this minimal — only the event kinds this PR uses. Future event kinds can extend the union.

Create `apps/backend/src/services/sellOrderAudit.ts`:

```ts
// SO audit-log helpers — parallel to services/orderAudit.ts (PO) but
// scoped to sell_orders + sell_order_events. No cross-references; PO and
// SO timelines are independent.
//
// All writes assume they are running inside the caller's transaction, so
// an audit row is committed only if the change it describes is also
// committed.

import type { Sql, TransactionSql } from 'postgres';

export type SqlLike = Sql | TransactionSql;

export type SellOrderEventKind =
  | 'archived'
  | 'unarchived';

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
Expected: PASS (no usages yet, so just shape-checks the new file).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/services/sellOrderAudit.ts
git commit -m "feat(be): writeSellOrderEvent audit helper"
```

---

## Task 4: Backend — `GET /api/sell-orders` includeArchived filter + `archivedAt` field

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts:59-118` (the list handler)
- Test: `apps/backend/tests/sell-orders.test.ts` (extend with a new `describe` block)

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/tests/sell-orders.test.ts`:

```ts
import { getDb } from '../src/db';

describe('GET /api/sell-orders — archive filter', () => {
  beforeEach(async () => { await resetDb(); });

  it('hides archived sell orders by default; includes them with ?includeArchived=true', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);

    // Soft-archive directly via SQL (the endpoints don't exist yet).
    const sql = getDb(process.env as never);
    await sql`UPDATE sell_orders SET archived_at = NOW() WHERE id = ${id}`;

    const def = await api<{ orders: { id: string; archivedAt: string | null }[] }>(
      'GET', '/api/sell-orders', { token },
    );
    expect(def.status).toBe(200);
    expect(def.body.orders.find(o => o.id === id)).toBeUndefined();

    const all = await api<{ orders: { id: string; archivedAt: string | null }[] }>(
      'GET', '/api/sell-orders?includeArchived=true', { token },
    );
    expect(all.status).toBe(200);
    const row = all.body.orders.find(o => o.id === id);
    expect(row).toBeDefined();
    expect(row!.archivedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: FAIL — the default list still returns the archived row (filter not implemented yet) and / or `archivedAt` is missing from the response.

- [ ] **Step 3: Implement the filter + field in the list handler**

In `apps/backend/src/routes/sellOrders.ts:59-118`, modify the handler:

Add right after the `statusFrag` declaration (around line 64):

```ts
const includeArchived = c.req.query('includeArchived') === 'true';
const archivedFrag = includeArchived ? sql`TRUE` : sql`so.archived_at IS NULL`;
```

Update the SELECT to include `so.archived_at`:

```ts
const rows = await sql`
  SELECT
    so.id, so.status, so.notes, so.created_at, so.archived_at,
    c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short,
    COUNT(sol.id)::int                                AS line_count,
    COALESCE(SUM(sol.qty), 0)::int                    AS qty,
    COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS subtotal
  FROM sell_orders so
  JOIN customers c ON c.id = so.customer_id
  LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
  WHERE ${statusFrag} AND ${archivedFrag} ${cursorFrag}
  GROUP BY so.id, c.id
  ORDER BY so.created_at DESC, so.id DESC
  LIMIT ${limit + 1}
`;
```

Update the row-shape `.map(r => ({ ... }))` to include `archivedAt: r.archived_at`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: PASS for the new test, and all pre-existing `sell-orders.test.ts` tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts apps/backend/tests/sell-orders.test.ts
git commit -m "feat(be): sell-order list supports ?includeArchived + archivedAt field"
```

---

## Task 5: Backend — `GET /api/sell-orders/:id` includes `archivedAt`

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts` (the detail handler around line 119-200)
- Test: `apps/backend/tests/sell-orders.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the same `describe('GET /api/sell-orders — archive filter', …)` block:

```ts
  it('detail response includes archivedAt', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);

    const sql = getDb(process.env as never);
    await sql`UPDATE sell_orders SET archived_at = NOW() WHERE id = ${id}`;

    const got = await api<{ order: { id: string; archivedAt: string | null } }>(
      'GET', `/api/sell-orders/${id}`, { token },
    );
    expect(got.status).toBe(200);
    expect(got.body.order.archivedAt).not.toBeNull();
  });
```

- [ ] **Step 2: Run to verify FAIL**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: FAIL — `archivedAt` is undefined on the detail response.

- [ ] **Step 3: Implement in the detail handler**

In `apps/backend/src/routes/sellOrders.ts` find the `SELECT so.id, so.status, so.notes, so.created_at, ...` inside the detail GET (around line 126). Add `so.archived_at` to the SELECT list, update the `head` typed cast to include `archived_at: string | null`, and add `archivedAt: head.archived_at` to the JSON response shape.

- [ ] **Step 4: Run test to verify PASS**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts apps/backend/tests/sell-orders.test.ts
git commit -m "feat(be): sell-order detail response exposes archivedAt"
```

---

## Task 6: Backend — `POST /api/sell-orders/:id/archive` + `/unarchive` (happy path)

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts` (add helper + routes at end of file, before `export default`)
- Test: `apps/backend/tests/sell-orders.test.ts`

- [ ] **Step 1: Write the failing tests (happy path + round-trip)**

Append to `apps/backend/tests/sell-orders.test.ts`:

```ts
describe('POST /api/sell-orders/:id/archive (+/unarchive)', () => {
  beforeEach(async () => { await resetDb(); });

  // Advance a sell order out of Draft so it is eligible for archive.
  async function nonDraftSellOrder(token: string): Promise<string> {
    const id = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', meta: { note: 'shipped for test' } },
    });
    expect(r.status).toBe(200);
    return id;
  }

  it('manager can archive a non-Draft sell order, and unarchive it back', async () => {
    const { token } = await loginAs(ALEX);
    const id = await nonDraftSellOrder(token);

    const arch = await api('POST', `/api/sell-orders/${id}/archive`, { token });
    expect(arch.status).toBe(200);

    const got = await api<{ order: { archivedAt: string | null } }>(
      'GET', `/api/sell-orders/${id}`, { token },
    );
    expect(got.body.order.archivedAt).not.toBeNull();

    const unarch = await api('POST', `/api/sell-orders/${id}/unarchive`, { token });
    expect(unarch.status).toBe(200);
    const got2 = await api<{ order: { archivedAt: string | null } }>(
      'GET', `/api/sell-orders/${id}`, { token },
    );
    expect(got2.body.order.archivedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 3: Implement `setSellOrderArchived` + mount routes**

In `apps/backend/src/routes/sellOrders.ts`:

Add at the top of the file alongside existing imports:

```ts
import type { Context } from 'hono';
import { writeSellOrderEvent } from '../services/sellOrderAudit';
```

Add just before the final `export default sellOrders;`:

```ts
// ── Archive / unarchive a Sell Order.
//
// Archive is a reversible "hide from default list" flag (sell_orders.archived_at).
// Manager-only (sell-orders is a manager-only surface throughout). The handler
// runs inside sql.begin with a row-level lock so concurrent archive +
// unarchive can't race, and so the audit event is only committed if the flag
// flip succeeds.
type SOCtx = Context<{ Bindings: Env; Variables: { user: User } }>;

async function setSellOrderArchived(c: SOCtx, archive: boolean) {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id') as string;
  const sql = getDb(c.env);

  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'isDraft' }
    | { kind: 'noChange' }
    | { kind: 'ok' };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const existing = (await tx`
      SELECT status, archived_at FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0] as { status: string; archived_at: string | null } | undefined;
    if (!existing) return { kind: 'notFound' };
    // Draft sell orders use Delete, not Archive — Archive only applies once
    // an order is part of the business record.
    if (existing.status === 'Draft') return { kind: 'isDraft' };
    const wasArchived = existing.archived_at !== null;
    if (wasArchived === archive) return { kind: 'noChange' };

    if (archive) {
      await tx`UPDATE sell_orders SET archived_at = NOW() WHERE id = ${id}`;
    } else {
      await tx`UPDATE sell_orders SET archived_at = NULL WHERE id = ${id}`;
    }
    await writeSellOrderEvent(
      tx, id, u.id,
      archive ? 'archived' : 'unarchived',
      {},
    );
    return { kind: 'ok' };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'isDraft') {
    return c.json({ error: 'Draft sell orders cannot be archived — delete instead' }, 403);
  }
  if (outcome.kind === 'noChange') {
    return c.json({ error: archive ? 'Sell order is already archived' : 'Sell order is not archived' }, 409);
  }
  return c.json({ ok: true });
}

sellOrders.post('/:id/archive',   c => setSellOrderArchived(c, true));
sellOrders.post('/:id/unarchive', c => setSellOrderArchived(c, false));
```

- [ ] **Step 4: Run to verify PASS**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: PASS for the new test + all pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts apps/backend/tests/sell-orders.test.ts
git commit -m "feat(be): POST /api/sell-orders/:id/archive + /unarchive"
```

---

## Task 7: Backend — edge-case tests (draft, 409, role guard, events)

**Files:**
- Test: `apps/backend/tests/sell-orders.test.ts` (extend the same `describe` block)
- Modify: `apps/backend/src/routes/sellOrders.ts` (only if a test reveals a gap — implementation should already cover these)

- [ ] **Step 1: Add the four tests**

Append inside `describe('POST /api/sell-orders/:id/archive (+/unarchive)', …)`:

```ts
  it('refuses to archive a Draft (delete instead)', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    const r = await api<{ error: string }>(
      'POST', `/api/sell-orders/${id}/archive`, { token },
    );
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/delete instead/);
  });

  it('double-archive returns 409', async () => {
    const { token } = await loginAs(ALEX);
    const id = await nonDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/archive`, { token });
    const r = await api('POST', `/api/sell-orders/${id}/archive`, { token });
    expect(r.status).toBe(409);
  });

  it('non-manager (purchaser) gets 403', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = await nonDraftSellOrder(mgr);
    const { token: pTok } = await loginAs(MARCUS);
    const r = await api('POST', `/api/sell-orders/${id}/archive`, { token: pTok });
    expect(r.status).toBe(403);
  });

  it('writes archived / unarchived audit events into sell_order_events', async () => {
    const { token } = await loginAs(ALEX);
    const id = await nonDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/archive`,   { token });
    await api('POST', `/api/sell-orders/${id}/unarchive`, { token });

    const sql = getDb(process.env as never);
    const evts = await sql<{ kind: string }[]>`
      SELECT kind FROM sell_order_events
      WHERE sell_order_id = ${id}
      ORDER BY created_at ASC
    `;
    const kinds = evts.map(e => e.kind);
    expect(kinds).toContain('archived');
    expect(kinds).toContain('unarchived');
  });
```

`nonDraftSellOrder` and the `MARCUS` import should already be in scope from prior tasks; the existing top-of-file import already covers `MARCUS`.

- [ ] **Step 2: Run to verify PASS**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: all 4 new tests PASS (the implementation from Task 6 already covers each case). If anything fails, fix the route handler rather than the test.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/tests/sell-orders.test.ts
git commit -m "test(be): sell-order archive edge cases (draft, 409, role, events)"
```

---

## Task 8: Backend — concurrent archive uses row lock (FOR UPDATE)

**Files:**
- Test: `apps/backend/tests/sell-orders.test.ts`

- [ ] **Step 1: Add the concurrency test**

Append to the same describe block:

```ts
  it('two concurrent archive POSTs result in one ok + one 409 (FOR UPDATE lock)', async () => {
    const { token } = await loginAs(ALEX);
    const id = await nonDraftSellOrder(token);

    const [a, b] = await Promise.all([
      api('POST', `/api/sell-orders/${id}/archive`, { token }),
      api('POST', `/api/sell-orders/${id}/archive`, { token }),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
  });
```

- [ ] **Step 2: Run to verify PASS**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: PASS. Without the `FOR UPDATE` lock both calls would race and both succeed (200/200), so this test would fail. The implementation from Task 6 already takes the lock.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/tests/sell-orders.test.ts
git commit -m "test(be): concurrent archive guarded by row lock"
```

---

## Task 9: Backend — append-only guard test for `sell_order_events`

**Files:**
- Test: `apps/backend/tests/sell-orders.test.ts`

- [ ] **Step 1: Add the trigger test**

Append a small standalone `describe`:

```ts
describe('sell_order_events append-only triggers', () => {
  beforeEach(async () => { await resetDb(); });

  it('UPDATE on sell_order_events raises the lock exception', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', meta: { note: 'n' } },
    });
    await api('POST', `/api/sell-orders/${id}/archive`, { token });

    const sql = getDb(process.env as never);
    await expect(sql`UPDATE sell_order_events SET kind = 'tampered' WHERE sell_order_id = ${id}`)
      .rejects.toThrow(/append-only/);
  });
});
```

- [ ] **Step 2: Run to verify PASS**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: PASS. The trigger from migration 0047 raises the error.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/tests/sell-orders.test.ts
git commit -m "test(be): sell_order_events append-only trigger fires on UPDATE"
```

---

## Task 10: Frontend — API helpers + type updates

**Files:**
- Modify: `apps/frontend/src/lib/api.ts` (alongside the existing `archiveOrder` / `unarchiveOrder`)
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` (types around line 29-39 and 93-100)

- [ ] **Step 1: Add the API helpers**

In `apps/frontend/src/lib/api.ts`, just after the existing PO `unarchiveOrder` (around line 125), add:

```ts
export const archiveSellOrder = (id: string) =>
  api.post<{ ok: true }>(`/api/sell-orders/${id}/archive`, {});

export const unarchiveSellOrder = (id: string) =>
  api.post<{ ok: true }>(`/api/sell-orders/${id}/unarchive`, {});
```

- [ ] **Step 2: Extend the SO types**

In `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`:

Add `archivedAt: string | null;` to the `SellOrderSummary` type (around line 29-39).

Add `archivedAt: string | null;` to the `SellOrderDetailType` type (around line 93-100).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS — no usages yet, just type definitions and exports.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/api.ts apps/frontend/src/pages/desktop/DesktopSellOrders.tsx
git commit -m "feat(fe): archiveSellOrder/unarchiveSellOrder helpers + archivedAt types"
```

---

## Task 11: Frontend — `ArchiveSellOrderDialog` component

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` (add component at the bottom of the file, before the default export)

- [ ] **Step 1: Add the dialog component**

Append to `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` (before the file's last export):

```tsx
// Type-the-SO-id confirm dialog. Local to DesktopSellOrders — the only
// caller. Disabled "Archive" button until the typed text exactly matches
// the order id (case-sensitive). Errors render inline; dialog stays open
// so the user can retry.
function ArchiveSellOrderDialog({
  orderId, onCancel, onConfirmed,
}: {
  orderId: string;
  onCancel: () => void;
  onConfirmed: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeKey(onCancel);

  const matches = typed.trim() === orderId;

  const submit = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await archiveSellOrder(orderId);
      onConfirmed();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Archive failed';
      setError(msg);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-shell" style={{ maxWidth: 460, width: 'calc(100vw - 80px)' }}>
        <div className="modal-head">
          <div className="modal-title">Archive sell order</div>
        </div>
        <div className="modal-body" style={{ padding: 20 }}>
          <p style={{ marginTop: 0, fontSize: 13.5 }}>
            Archiving hides this sell order from the default list. It stays in the
            database with its lines, commissions, and audit history intact, and can
            be unarchived later.
          </p>
          <label className="label" style={{ marginTop: 12 }}>
            Type <span className="mono" style={{ fontWeight: 600 }}>{orderId}</span> to confirm
          </label>
          <input
            className="input mono"
            autoFocus
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && matches) submit(); }}
            placeholder={orderId}
          />
          {error && (
            <div role="alert" style={{ marginTop: 10, color: 'var(--neg, #c0392b)', fontSize: 13 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn danger"
            onClick={submit}
            disabled={!matches || busy}
            style={{ background: 'var(--neg, #c0392b)', color: '#fff', borderColor: 'transparent' }}
          >
            {busy ? 'Archiving…' : 'Archive'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Also add to the existing import at the top of the file: `archiveSellOrder` from `../../lib/api`:

```ts
import { api, archiveSellOrder, unarchiveSellOrder } from '../../lib/api';
```

(`unarchiveSellOrder` is imported here so Task 12 doesn't have to change the import line again.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS. `ArchiveSellOrderDialog` is defined but not yet rendered — that's fine, React doesn't tree-shake until build.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSellOrders.tsx
git commit -m "feat(fe): ArchiveSellOrderDialog with type-to-confirm guard"
```

---

## Task 12: Frontend — wire Archive / Unarchive button into the SO edit modal footer

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` — the `SellOrderDetail` component's footer block around lines 722-751.

- [ ] **Step 1: Add dialog + unarchive state**

Inside `SellOrderDetail` (around line 375 alongside `pending`), add:

```ts
const [confirmArchive, setConfirmArchive] = useState(false);
const [unarchiving, setUnarchiving] = useState(false);
```

- [ ] **Step 2: Add the buttons to the footer**

In the `<div className="so-footer">` block (around line 723) — inside the `<div style={{ display: 'flex', gap: 8 }}>` action group near line 733 — insert the Archive / Unarchive button to the LEFT of `Cancel`, but only when in edit mode and not Draft.

Replace the existing action group:

```tsx
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
              {!editable && order.status !== 'Done' && (
                <button className="btn accent" onClick={onSwitchToEdit}>
                  <Icon name="edit" size={14} /> Edit order
                </button>
              )}
              {editable && (
                <button
                  className="btn accent"
                  onClick={save}
                  disabled={!dirty || saving}
                >
                  <Icon name="check2" size={14} /> {saving ? 'Saving…' : 'Save changes'}
                </button>
              )}
            </div>
```

with:

```tsx
            <div style={{ display: 'flex', gap: 8 }}>
              {editable && order.status !== 'Draft' && order.archivedAt === null && (
                <button
                  className="btn"
                  onClick={() => setConfirmArchive(true)}
                  title="Archive this sell order"
                  style={{ color: 'var(--neg, #c0392b)', borderColor: 'var(--neg, #c0392b)' }}
                >
                  <Icon name="box" size={14} /> Archive
                </button>
              )}
              {editable && order.archivedAt !== null && (
                <button
                  className="btn"
                  disabled={unarchiving}
                  onClick={async () => {
                    setUnarchiving(true);
                    try {
                      await unarchiveSellOrder(order.id);
                      onSaved();
                      onClose();
                    } catch (e) {
                      handleFetchError(e);
                      setUnarchiving(false);
                    }
                  }}
                >
                  <Icon name="box" size={14} /> {unarchiving ? 'Unarchiving…' : 'Unarchive'}
                </button>
              )}
              <button className="btn" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
              {!editable && order.status !== 'Done' && (
                <button className="btn accent" onClick={onSwitchToEdit}>
                  <Icon name="edit" size={14} /> Edit order
                </button>
              )}
              {editable && (
                <button
                  className="btn accent"
                  onClick={save}
                  disabled={!dirty || saving}
                >
                  <Icon name="check2" size={14} /> {saving ? 'Saving…' : 'Save changes'}
                </button>
              )}
            </div>
```

- [ ] **Step 3: Render the dialog**

In the JSX tail of `SellOrderDetail`, right after the existing `{pending && order && draft && statusMeta && (<StatusChangeDialog … />)}` block (around line 754-771), add:

```tsx
    {confirmArchive && order && (
      <ArchiveSellOrderDialog
        orderId={order.id}
        onCancel={() => setConfirmArchive(false)}
        onConfirmed={() => { setConfirmArchive(false); onSaved(); onClose(); }}
      />
    )}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSellOrders.tsx
git commit -m "feat(fe): Archive/Unarchive buttons in SO edit modal footer"
```

---

## Task 13: Frontend — `Show archived` toggle + archived chip + faded rows

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` — list page (the outer component, not `SellOrderDetail`)

- [ ] **Step 1: Find the list page component and its existing fetch effect**

The outer list component fetches via `api.get<{ orders: SellOrderSummary[] }>('/api/sell-orders' + queryString)`. Locate that effect and the `useState`-style row near the top of the component, then identify the card header where filters live (similar to `DesktopOrders.tsx:340-380` for PO).

- [ ] **Step 2: Add the persisted state**

Add near the other list-page hooks:

```ts
import { usePersisted } from '../../lib/preferences';
// ...
const [showArchived, setShowArchived] = usePersisted<boolean>('desktop.sellOrders.showArchived', false);
```

- [ ] **Step 3: Append `?includeArchived=true` to the list fetch when toggled on**

Whatever query-string builder the list uses, conditionally append `includeArchived=true`. Add `showArchived` to the effect's dependency array so toggling refetches.

If the existing fetch is `api.get('/api/sell-orders')` with no params, update to:

```ts
const params = new URLSearchParams();
if (showArchived) params.set('includeArchived', 'true');
const qs = params.toString();
api.get<{ orders: SellOrderSummary[] }>(`/api/sell-orders${qs ? '?' + qs : ''}`)
```

- [ ] **Step 4: Add the toggle button in the card header**

Mirror the PO list toggle from `DesktopOrders.tsx:354-367`:

```tsx
<button
  className="btn"
  onClick={() => setShowArchived(v => !v)}
  title={showArchived ? 'Hide archived sell orders' : 'Show archived sell orders'}
  style={{
    height: 32, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6,
    background: showArchived ? 'var(--bg-soft)' : undefined,
    borderColor: showArchived ? 'var(--border-strong)' : undefined,
    color: showArchived ? 'var(--fg)' : 'var(--fg-muted)',
  }}
>
  <Icon name="box" size={12} />
  {showArchived ? 'Hide archived' : 'Show archived'}
</button>
```

Place it inside the existing actions group on the card header (the same row as the search input).

- [ ] **Step 5: Fade archived rows + render `archived` chip**

On the `<tr>` for each sell-order row, add inline style:

```tsx
style={{ cursor: 'pointer', opacity: o.archivedAt ? 0.55 : 1 }}
```

In the ID cell, after the existing share / link UI, add the chip:

```tsx
{o.archivedAt && (
  <span className="chip muted" style={{ fontSize: 10, padding: '1px 6px', marginLeft: 6 }}>
    <Icon name="box" size={9} style={{ marginRight: 3 }} />
    archived
  </span>
)}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSellOrders.tsx
git commit -m "feat(fe): Show archived toggle + chip + faded rows on sell-order list"
```

---

## Task 14: Final verification

**Files:** none

- [ ] **Step 1: Full backend test sweep**

Run: `pnpm --filter recycle-erp-backend test`
Expected: full suite green. If `sell-orders.test.ts` or any other suite fails, fix and recommit before moving on.

- [ ] **Step 2: Full frontend test + typecheck sweep**

Run:
```
pnpm --filter recycle-erp-frontend typecheck
pnpm --filter recycle-erp-frontend test
```
Expected: green.

- [ ] **Step 3: Manual smoke (desktop, manager login)**

In the running dev environment (`pnpm dev`):

1. Open `/sell-orders` as a manager. Open any non-Draft SO via the row → Edit order.
2. Confirm a red **Archive** button appears in the footer.
3. Click it. The dialog asks to type the SO id; the **Archive** button stays disabled until the input matches.
4. Type the id and confirm. The dialog closes, the modal closes, the row disappears from the default list.
5. Click **Show archived** in the list header. The archived row reappears with the `archived` chip and faded styling.
6. Re-open the archived order. Confirm the **Unarchive** button appears (no Archive button). Click it → row returns to the active list.
7. Open a Draft SO. Confirm the Archive button is hidden.

- [ ] **Step 4: Report**

No further commit — the previous commits cover all changes. Report to the user: tests run, manual smoke completed, all green.

---

## Self-review checklist (for the implementer)

- **Spec coverage:** Both migrations present (0046, 0047). List filter, detail field, archive + unarchive endpoints, audit emission, append-only trigger test, role guard test, concurrency test — all covered.
- **No mobile changes:** intentional, per spec.
- **No PO changes:** intentional, per spec.
- **No `sell_order_events` emission outside archive flow:** intentional — broader audit coverage is deferred.
