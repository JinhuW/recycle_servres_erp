# Per-Order Commission Rate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the tiered commission model, the payment-type "Commission rules" panel, and the per-user default rate; replace them with a single per-order `commission_rate` set by a manager in the PO detail.

**Architecture:** Add a nullable `orders.commission_rate` (no default). Commission everywhere = `Σ order.profit × COALESCE(order.commission_rate, 0)`. Tasks are ordered so the column is added first and dropped last — the test suite stays green at every commit (the old column/tables are removed only after all code stops referencing them).

**Tech Stack:** Hono + postgres.js (backend), React + Vite (frontend), Vitest, idempotent SQL migrations (the runner re-applies every migration each run; `resetDb()` replays migrations then runs `seed.mjs`).

Spec: `docs/superpowers/specs/2026-05-17-per-order-commission-rate-design.md`

---

## File Structure

- **Create** `apps/backend/migrations/0030_per_order_commission_rate.sql` — adds the column (Task 1); drops old model (Task 8).
- **Modify** `apps/backend/scripts/seed.mjs` — seed per-order rate (Task 1); remove old seeding (Task 8).
- **Modify** `apps/backend/src/routes/dashboard.ts` — per-order commission (Task 2).
- **Modify** `apps/backend/src/routes/orders.ts` — surface + PATCH the rate (Task 3).
- **Modify** `apps/backend/src/routes/me.ts` — Profile lifetime commission (Task 4).
- **Modify** `apps/backend/src/services/members.ts` — drop `commission_rate` (Task 5).
- **Modify** `apps/frontend/src/lib/types.ts`, `pages/desktop/DesktopEditOrder.tsx`, `pages/desktop/DesktopOrders.tsx`, `pages/desktop/DesktopSettings.tsx` — UI (Task 6).
- **Delete** `apps/backend/src/routes/commission.ts`, `apps/backend/src/lib/commission-calc.ts`, `apps/backend/tests/commission.test.ts`; **Modify** `apps/backend/src/index.ts` (Task 7).
- **Modify** tests: `apps/backend/tests/dashboard.test.ts` (Task 2), `tests/orders.test.ts` (Task 3).

All backend test runs use working dir `apps/backend`. Frontend has **no DOM test harness** (pure-logic Vitest only); frontend verification is `npx tsc --noEmit` plus the noted manual check.

---

## Task 1: Add `orders.commission_rate` column + seed it

**Files:**
- Create: `apps/backend/migrations/0030_per_order_commission_rate.sql`
- Modify: `apps/backend/scripts/seed.mjs`
- Test: `apps/backend/tests/orders.test.ts` (temporary column-exists assertion)

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/tests/orders.test.ts`:

```ts
describe('orders.commission_rate column', () => {
  beforeEach(async () => { await resetDb(); });

  it('exists and is nullable, seeded non-null on at least one order', async () => {
    const { getTestDb } = await import('./helpers/db');
    const db = getTestDb();
    const rows = await db<{ commission_rate: number | null }[]>`
      SELECT commission_rate FROM orders
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.commission_rate !== null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/orders.test.ts -t "commission_rate column"`
Expected: FAIL — `column "commission_rate" does not exist`.

- [ ] **Step 3: Create the migration (column only — no drops yet)**

Create `apps/backend/migrations/0030_per_order_commission_rate.sql`:

```sql
-- Per-order commission rate set by a manager in the PO detail. Nullable with
-- NO default: NULL means "manager has not set a rate" = $0 commission. The
-- old tiered model, commission_settings and users.commission_rate are dropped
-- in a later step of the same migration (added once all code is migrated off
-- them). Idempotent: the runner re-applies every migration each run.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,4);
```

- [ ] **Step 4: Seed the new column**

In `apps/backend/scripts/seed.mjs`, find the order INSERT (the block
beginning `INSERT INTO orders (id, user_id, category, warehouse_id, payment,
notes, total_cost, lifecycle, created_at)`). Add `commission_rate` to the
column list and a value that is non-null for non-draft orders, NULL for
drafts:

```js
    await sql`
      INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle, created_at, commission_rate)
      VALUES (${o.id}, ${protoToUuid[o.user_id]}, ${o.category}, ${o.warehouse_id}, ${o.payment}, ${o.notes}, ${o.total_cost}, ${o.lifecycle}, ${o.created_at},
              ${o.lifecycle === 'draft' ? null : 0.075})
    `;
```

(Leave the existing `users.commission_rate`, tiers and commission_settings
seeding untouched for now — removed in Task 8.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/orders.test.ts -t "commission_rate column"`
Expected: PASS.

- [ ] **Step 6: Run the full suite (still green)**

Run: `cd apps/backend && npx vitest run`
Expected: all files pass (old commission code still works; column is additive).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/migrations/0030_per_order_commission_rate.sql apps/backend/scripts/seed.mjs apps/backend/tests/orders.test.ts
git commit -m "feat(commission): add nullable orders.commission_rate + seed it"
```

---

## Task 2: Dashboard commission from per-order rate

**Files:**
- Modify: `apps/backend/src/routes/dashboard.ts`
- Test: `apps/backend/tests/dashboard.test.ts`

- [ ] **Step 1: Replace the dashboard invariant test**

In `apps/backend/tests/dashboard.test.ts`, delete the test named
`purchaser KPI commission equals their aggregate (tier-correct, not per-line sum)`
and replace it with:

```ts
  it('KPI commission = sum of profit x per-order rate, matching the leaderboard', async () => {
    const { token, user } = await loginAs(MARCUS);
    const r = await api<{
      kpis: { commission: number };
      leaderboard: { id: string; commission: number | null }[];
    }>('GET', '/api/dashboard?range=90d', { token });
    expect(r.status).toBe(200);
    const mine = r.body.leaderboard.find(x => x.id === user.id);
    expect(mine?.commission).not.toBeNull();
    // A purchaser's whole-dashboard scope is exactly their own orders, so the
    // KPI commission must equal their leaderboard commission.
    expect(r.body.kpis.commission).toBeCloseTo(mine!.commission as number, 2);
  });

  it('an order with a NULL commission_rate contributes $0', async () => {
    const { getTestDb } = await import('./helpers/db');
    const db = getTestDb();
    await db`UPDATE orders SET commission_rate = NULL`;
    const { token } = await loginAs(ALEX);
    const r = await api<{ kpis: { commission: number } }>(
      'GET', '/api/dashboard?range=90d', { token });
    expect(r.status).toBe(200);
    expect(r.body.kpis.commission).toBe(0);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd apps/backend && npx vitest run tests/dashboard.test.ts`
Expected: the `$0` test FAILS (old tier code ignores `commission_rate`); the invariant test may pass or fail. Both must pass after Step 3.

- [ ] **Step 3: Rewrite the commission logic in `dashboard.ts`**

In `apps/backend/src/routes/dashboard.ts`:

a) Remove the import line:
```ts
import { computeCommission, type Tier } from '../lib/commission-calc';
```

b) Delete the `const tiers = await sql<Tier[]>\`... FROM commission_tiers ...\`;` block.

c) Replace the `const perUser = await sql<...>\`...\`;` block and the
`let commission = 0; for (const p of perUser) ...; commission = +commission.toFixed(2);`
lines with:

```ts
  // Commission is the per-order rate the manager set, applied to that order's
  // profit, summed over the scope. NULL rate = $0.
  const perOrder = await sql<{ profit: number; commission_rate: number | null }[]>`
    SELECT
      COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit,
      o.commission_rate::float AS commission_rate
    FROM orders o
    LEFT JOIN order_lines l ON l.order_id = o.id
    WHERE o.created_at >= NOW() - (${days} || ' days')::interval AND ${scopeFrag}
    GROUP BY o.id, o.commission_rate
  `;
  let commission = 0;
  for (const r of perOrder) commission += r.profit * (r.commission_rate ?? 0);
  commission = +commission.toFixed(2);
```

d) Replace the entire `leaderboardRaw` query and the `leaderboard` mapping's
`commission` field. Change the `leaderboardRaw` SQL to:

```ts
  const leaderboardRaw = await sql<{
    id: string; name: string; initials: string; email: string; role: string;
    count: number; revenue: number; profit: number; commission: number;
  }[]>`
    WITH per_order AS (
      SELECT o.id, o.user_id, o.commission_rate::float AS rate,
             COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float AS revenue,
             COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit
      FROM orders o JOIN order_lines l ON l.order_id = o.id
      WHERE o.created_at >= NOW() - (${days} || ' days')::interval
      GROUP BY o.id, o.user_id, o.commission_rate
    )
    SELECT u.id, u.name, u.initials, u.email, u.role,
           COUNT(DISTINCT po.id)::int AS count,
           COALESCE(SUM(po.revenue), 0)::float AS revenue,
           COALESCE(SUM(po.profit), 0)::float AS profit,
           COALESCE(SUM(po.profit * COALESCE(po.rate, 0)), 0)::float AS commission
    FROM users u JOIN per_order po ON po.user_id = u.id
    WHERE u.role = 'purchaser'
    GROUP BY u.id, u.name, u.initials, u.email, u.role
    ORDER BY profit DESC
  `;
```

Then in the `const leaderboard = leaderboardRaw.map(row => { ... })` block,
change the `commission` field from the `computeCommission(...)` call to:

```ts
      commission: showFinancials ? +row.commission.toFixed(2) : null,
```

- [ ] **Step 4: Run to verify the dashboard tests pass**

Run: `cd apps/backend && npx vitest run tests/dashboard.test.ts`
Expected: PASS (all dashboard tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/dashboard.ts apps/backend/tests/dashboard.test.ts
git commit -m "feat(commission): dashboard uses per-order rate, drops tier model"
```

---

## Task 3: Surface + PATCH the per-order rate in the orders API

**Files:**
- Modify: `apps/backend/src/routes/orders.ts`
- Test: `apps/backend/tests/orders.test.ts`

- [ ] **Step 1: Replace the stale commission test**

In `apps/backend/tests/orders.test.ts`, replace the `describe('GET /api/orders — commission rate', ...)` block (the test asserting `commissionRate` is `0.075`) with:

```ts
describe('GET /api/orders — per-order commission rate', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns the order\'s own commission_rate (null when unset)', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ orders: { id: string; commissionRate: number | null }[] }>(
      'GET', '/api/orders', { token });
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBeGreaterThan(0);
    // seed: drafts are null, others 0.075
    expect(r.body.orders.some(o => o.commissionRate === 0.075)).toBe(true);
  });

  it('manager can PATCH commissionRate; purchaser is forbidden', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const list = await api<{ orders: { id: string; userId: string }[] }>(
      'GET', '/api/orders', { token: mgr });
    const target = list.body.orders[0];

    const ok = await api('PATCH', `/api/orders/${target.id}`,
      { token: mgr, body: { commissionRate: 0.1 } });
    expect(ok.status).toBe(200);

    const after = await api<{ orders: { id: string; commissionRate: number | null }[] }>(
      'GET', '/api/orders', { token: mgr });
    expect(after.body.orders.find(o => o.id === target.id)!.commissionRate).toBeCloseTo(0.1, 4);

    // A purchaser editing their own order's rate is rejected.
    const { token: pur, user: pu } = await loginAs(MARCUS);
    const mine = (await api<{ orders: { id: string; userId: string }[] }>(
      'GET', '/api/orders', { token: pur })).body.orders.find(o => o.userId === pu.id)!;
    const denied = await api('PATCH', `/api/orders/${mine.id}`,
      { token: pur, body: { commissionRate: 0.2 } });
    expect(denied.status).toBe(403);
  });

  it('clamps out-of-range rate and allows null to unset', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = (await api<{ orders: { id: string }[] }>('GET', '/api/orders', { token: mgr })).body.orders[0].id;
    await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: 5 } });
    let r = await api<{ orders: { id: string; commissionRate: number | null }[] }>('GET', '/api/orders', { token: mgr });
    expect(r.body.orders.find(o => o.id === id)!.commissionRate).toBe(1);
    await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: null } });
    r = await api<{ orders: { id: string; commissionRate: number | null }[] }>('GET', '/api/orders', { token: mgr });
    expect(r.body.orders.find(o => o.id === id)!.commissionRate).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd apps/backend && npx vitest run tests/orders.test.ts -t "per-order commission rate"`
Expected: FAIL — `commissionRate` still comes from `users` (always 0.075, never null), PATCH does not accept `commissionRate`.

- [ ] **Step 3: Surface `o.commission_rate` in `GET /api/orders`**

In `apps/backend/src/routes/orders.ts`, in the list query, change:

```ts
      u.commission_rate::float AS commission_rate,
```
to:
```ts
      o.commission_rate::float AS commission_rate,
```

and in the same query's `GROUP BY`, remove `u.commission_rate,` (leave the
other grouped columns intact: `GROUP BY o.id, u.name, u.initials, w.id, w.short, w.region`).

The JSON mapping already does `commissionRate: r.commission_rate` — no change
needed there; it now yields `number | null`.

- [ ] **Step 4: Add `commissionRate` to `PATCH /api/orders/:id` (manager-only, clamped)**

In the `orders.patch('/:id', ...)` handler:

a) Add `commissionRate?: number | null;` to the body type union (alongside
`payment?: 'company' | 'self';`).

b) Immediately after the existing
`if (u.role !== 'manager' && existing.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);`
line, add:

```ts
  if (body.commissionRate !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can set the commission rate' }, 403);
  }
  const clampedRate =
    body.commissionRate === undefined ? undefined
    : body.commissionRate === null ? null
    : Math.min(1, Math.max(0, Number(body.commissionRate)));
```

c) In the `touchesOrder` boolean, add a clause:

```ts
      const touchesOrder =
        body.totalCost !== undefined ||
        body.notes !== undefined ||
        body.warehouseId !== undefined ||
        body.payment !== undefined ||
        body.commissionRate !== undefined;
```

d) Inside the `if (touchesOrder) { ... }` block, add a sentinel like the
other nullable fields. Add next to `const setWarehouse = ...`:

```ts
        const setCommission = body.commissionRate !== undefined ? 1 : 0;
```

and add this line to the `UPDATE orders SET` list (after the `warehouse_id`
line, before `payment`):

```ts
            commission_rate = CASE WHEN ${setCommission}::int = 1 THEN ${clampedRate ?? null} ELSE commission_rate END,
```

- [ ] **Step 5: Run to verify the orders tests pass**

Run: `cd apps/backend && npx vitest run tests/orders.test.ts`
Expected: PASS (all orders tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/orders.ts apps/backend/tests/orders.test.ts
git commit -m "feat(commission): orders API surfaces + manager-PATCHes per-order rate"
```

---

## Task 4: Profile lifetime commission from per-order rate

**Files:**
- Modify: `apps/backend/src/routes/me.ts`
- Test: `apps/backend/tests/orders.test.ts` (add a `/api/me` assertion) — or `tests/members.test.ts`; use a new file `tests/me-commission.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/me-commission.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

describe('GET /api/me — lifetime commission uses per-order rate', () => {
  beforeEach(async () => { await resetDb(); });

  it('is $0 when every order rate is NULL', async () => {
    const db = getTestDb();
    await db`UPDATE orders SET commission_rate = NULL`;
    const { token } = await loginAs(MARCUS);
    const r = await api<{ stats: { commission: number } }>('GET', '/api/me', { token });
    expect(r.status).toBe(200);
    expect(r.body.stats.commission).toBe(0);
  });
});
```

(If the `/api/me` response nests stats differently, adjust the path — verify
against `src/routes/me.ts`'s `c.json({...})` shape in Step 3.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && npx vitest run tests/me-commission.test.ts`
Expected: FAIL — commission is the hardcoded `0.075` calc, not 0.

- [ ] **Step 3: Use the per-order rate in `me.ts`**

In `apps/backend/src/routes/me.ts`, change the commission expression:

```ts
      COALESCE(SUM((sell_price - unit_cost) * qty * 0.075), 0)::float AS commission
```
to:
```ts
      COALESCE(SUM((sell_price - unit_cost) * qty * COALESCE(o.commission_rate, 0)), 0)::float AS commission
```

(The query already `JOIN orders o ON o.id = l.order_id`, so `o.commission_rate`
is in scope.) Confirm the JSON shape and fix the test's access path if needed.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/backend && npx vitest run tests/me-commission.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/me.ts apps/backend/tests/me-commission.test.ts
git commit -m "feat(commission): profile lifetime commission uses per-order rate"
```

---

## Task 5: Drop `commission_rate` from the members service

**Files:**
- Modify: `apps/backend/src/services/members.ts`
- Test: `apps/backend/tests/members.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/tests/members.test.ts`:

```ts
describe('members payload has no commission_rate', () => {
  beforeEach(async () => { await resetDb(); });

  it('GET /api/members items omit commission_rate', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ items: Record<string, unknown>[] }>(
      'GET', '/api/members?includeInactive=true', { token });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const m of r.body.items) expect('commission_rate' in m).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && npx vitest run tests/members.test.ts -t "no commission_rate"`
Expected: FAIL — `commission_rate` is still selected and present.

- [ ] **Step 3: Remove `commission_rate` from the service**

In `apps/backend/src/services/members.ts`:

a) In the `MemberSummary` interface, delete the line `commission_rate: number;`.

b) In `UpdateMemberInput` (or equivalent), delete `commissionRate?: number;`.

c) In `listMembers`'s SELECT, change
`u.active, u.commission_rate::float AS commission_rate, u.created_at,`
to
`u.active, u.created_at,`.

d) In `updateMember`'s UPDATE, delete the line
`commission_rate = COALESCE(${input.commissionRate ?? null},  commission_rate),`
(ensure the preceding line's trailing comma/SQL is still valid — the line
before it should now be the last `SET` assignment with no trailing comma).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/backend && npx vitest run tests/members.test.ts`
Expected: PASS (all members tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/members.ts apps/backend/tests/members.test.ts
git commit -m "refactor(commission): drop commission_rate from members service"
```

---

## Task 6: Frontend — per-order rate field, remove Commission rules + member rate

**Files:**
- Modify: `apps/frontend/src/lib/types.ts`
- Modify: `apps/frontend/src/pages/desktop/DesktopOrders.tsx`
- Modify: `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx`
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

No DOM test harness exists; verification is `npx tsc --noEmit` for both apps
plus the manual check in Step 7.

- [ ] **Step 1: Loosen the type**

In `apps/frontend/src/lib/types.ts`, change `commissionRate: number;` to
`commissionRate: number | null;`.

- [ ] **Step 2: Fix the commission display fallback**

In `apps/frontend/src/pages/desktop/DesktopOrders.tsx`, change line 28:

```ts
const commissionFor = (o: OrderSummary) => +(o.profit * (o.commissionRate ?? 0)).toFixed(2);
```

and update the comment above it to: `// Commission = order profit × the
manager-set per-order rate (null = not yet set = $0).`

- [ ] **Step 3: Add the Commission rate (%) field to the PO detail**

In `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx`:

a) Near the other `useState` hooks (e.g. next to `const [payment, setPayment]
= useState<'company' | 'self'>(order.payment);`), add:

```ts
  const [commissionPct, setCommissionPct] = useState<string>(
    order.commissionRate != null ? String(+(order.commissionRate * 100).toFixed(2)) : '');
```

b) Near the other `*Dirty` consts, add:

```ts
  const commissionDirty =
    (commissionPct === '' ? null : Number(commissionPct) / 100)
      !== (order.commissionRate ?? null);
```

and add `|| commissionDirty` to the combined dirty boolean (the one currently
`statusDirty || linesDirty || notesDirty || warehouseDirty || paymentDirty || totalCostDirty`).

c) In the `api.patch(\`/api/orders/${order.id}\`, { ... })` body object, add:

```ts
        commissionRate: commissionDirty
          ? (commissionPct === '' ? null : Number(commissionPct) / 100)
          : undefined,
```

d) Next to the existing `payment` field UI block (the `<label className="label">{t('payment')}</label>` group), add a sibling field. Use the same markup style as the surrounding form rows:

```tsx
            <label className="label">Commission rate (%)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              step="0.1"
              disabled={isPurchaser}
              value={commissionPct}
              placeholder={isPurchaser ? '—' : 'Set rate'}
              onChange={e => setCommissionPct(e.target.value)}
            />
```

(`isPurchaser` already exists in this file: `const isPurchaser = user?.role
!== 'manager';`.)

- [ ] **Step 4: Remove the Settings "Commission" section + panel**

In `apps/frontend/src/pages/desktop/DesktopSettings.tsx`:

a) In the `SectionId` type, remove `| 'commission'` (it reads
`'members' | 'warehouses' | 'customers' | 'categories' | 'commission' | 'general'`
→ drop `'commission'`).

b) Delete the nav entry object:
`{ id: 'commission', label: 'Commission', sub: 'Payment types', icon: 'dollar' },`

c) Delete the render line:
`{section === 'commission' && <CommissionPanel showToast={showToast} />}`

d) Delete the entire `CommissionPanel` component and its helpers — everything
from the `// ─── Commission tab ───` banner comment through the end of the
`CommissionPanel` function, including `type CommissionKey`, `type
CommissionRule`, and `COMMISSION_RULE_DEFAULTS`.

- [ ] **Step 5: Remove the per-member commission rate from the members panel**

In `apps/frontend/src/pages/desktop/DesktopSettings.tsx`:

a) In the member row type (the one with `active: boolean; commission_rate:
number;`), delete `commission_rate: number;`.

b) Remove the member-form commission input and its label — search for the
copy `Applied as commission baseline when no override is set.` and delete its
enclosing field group (label + input + the `cat-opt-sub` hint line). Remove
any now-unused `commission_rate` references in that form's state/submit body
so the file typechecks.

- [ ] **Step 6: Typecheck both apps**

Run: `cd apps/frontend && npx tsc --noEmit && echo FE_OK`
Run: `cd apps/backend && npx tsc --noEmit && echo BE_OK`
Expected: `FE_OK` and `BE_OK`, no errors.

- [ ] **Step 7: Manual smoke (no automated FE harness)**

Confirm by reading the diff: (1) `DesktopEditOrder` shows a read-only rate
field for purchasers and editable for managers; (2) `DesktopSettings` no
longer references `CommissionPanel`, `'commission'`, or `commission_rate`;
(3) no remaining `commissionRate ?? 0.05` anywhere
(`grep -rn "0.05\|commission_rate\|CommissionPanel" apps/frontend/src` returns nothing relevant).

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/lib/types.ts apps/frontend/src/pages/desktop/DesktopOrders.tsx apps/frontend/src/pages/desktop/DesktopEditOrder.tsx apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "feat(commission): PO-detail rate field; remove Commission rules + member rate UI"
```

---

## Task 7: Delete the commission route, calc lib, and its test

**Files:**
- Delete: `apps/backend/src/routes/commission.ts`
- Delete: `apps/backend/src/lib/commission-calc.ts`
- Delete: `apps/backend/tests/commission.test.ts`
- Modify: `apps/backend/src/index.ts`

- [ ] **Step 1: Remove the route mount and import**

In `apps/backend/src/index.ts`, delete these three lines:

```ts
import commissionRoutes from './routes/commission';
```
```ts
app.use('/api/commission/*', authMiddleware);
```
```ts
app.route('/api/commission', commissionRoutes);
```

- [ ] **Step 2: Delete the files**

```bash
git rm apps/backend/src/routes/commission.ts apps/backend/src/lib/commission-calc.ts apps/backend/tests/commission.test.ts
```

- [ ] **Step 3: Verify nothing else imports them**

Run: `cd apps/backend && grep -rn "commission-calc\|routes/commission\|computeCommission" src tests`
Expected: no output.

- [ ] **Step 4: Typecheck + full suite**

Run: `cd apps/backend && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all tests pass (`/api/commission` is gone and
nothing references it).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/index.ts
git commit -m "refactor(commission): delete /api/commission route, tier calc, its test"
```

---

## Task 8: Drop the old schema + remove old seeding (final clean break)

**Files:**
- Modify: `apps/backend/migrations/0030_per_order_commission_rate.sql`
- Modify: `apps/backend/scripts/seed.mjs`

- [ ] **Step 1: Add the drops to migration 0030**

Append to `apps/backend/migrations/0030_per_order_commission_rate.sql`:

```sql

-- Old commission model fully removed (all code is migrated off it). Idempotent.
DROP TABLE IF EXISTS commission_tiers CASCADE;
DROP TABLE IF EXISTS commission_settings CASCADE;
ALTER TABLE users DROP COLUMN IF EXISTS commission_rate;
```

- [ ] **Step 2: Remove old seeding from `seed.mjs`**

In `apps/backend/scripts/seed.mjs`, delete:

a) Any seeding of `commission_tiers` and `commission_settings` (search for
`commission_tiers`, `commission_settings`, `rate_company`, `pay_schedule`).

b) `users.commission_rate` from the users INSERT — remove the column from the
INSERT column list and its corresponding value (search the users seeding
block for `commission_rate`).

Leave the Task 1 `orders.commission_rate` seeding in place.

- [ ] **Step 3: Verify no remaining references**

Run: `cd apps/backend && grep -rn "commission_tiers\|commission_settings\|users.commission_rate\|u.commission_rate" src scripts tests`
Expected: no output.

- [ ] **Step 4: Full backend suite + both typechecks**

Run: `cd apps/backend && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; **all** tests pass.
Run: `cd apps/frontend && npx tsc --noEmit && echo FE_OK`
Expected: `FE_OK`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/migrations/0030_per_order_commission_rate.sql apps/backend/scripts/seed.mjs
git commit -m "feat(commission): drop tiers/commission_settings/users.commission_rate"
```

---

## Self-Review Notes

- **Spec coverage:** data model → Task 1 + 8; backend GET/PATCH → Task 3;
  dashboard → Task 2; me.ts → Task 4; delete route/calc → Task 7; frontend
  (PO field, DesktopOrders, settings panel removal, types) → Task 6; tests →
  Tasks 2,3,5 + delete in 7; seed → Tasks 1 & 8. Members service/UI gap
  (implied by dropping `users.commission_rate`) → Tasks 5 & 6.
- **Ordering:** column added in Task 1, dropped in Task 8; every intermediate
  commit keeps `apps/backend && npx vitest run` green.
- **Type consistency:** `commissionRate: number | null` (types.ts, orders
  JSON, DesktopEditOrder/DesktopOrders); `commission_rate` SQL column;
  `clampedRate` defined where used (Task 3).
- **No placeholders:** every code step shows the exact code/SQL/commands.
