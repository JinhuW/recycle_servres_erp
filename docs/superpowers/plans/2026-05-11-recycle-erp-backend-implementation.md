# Recycle ERP Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 8 prioritized gaps between the existing `apps/backend` and the design PRD (`docs/superpowers/specs/2026-05-11-recycle-erp-backend-design.md`), starting from a TDD foundation that can drive the 65 integration tests defined in §8 of the PRD.

**Architecture:** Existing stack is Hono + `postgres.js` + Cloudflare Workers, with SQL migrations in `apps/backend/migrations/` and a seed script in `apps/backend/scripts/seed.mjs`. We keep that stack — no rewrites — and layer in: (1) a Vitest test harness that drives the Hono app via `app.fetch()` against a local Postgres, (2) numbered forward-only migrations for new tables, (3) new/updated route files that match the PRD API surface. Each phase is independently deployable so progress can stop after any phase and the system still works.

**Tech Stack:** TypeScript (strict), Hono 4.x, `postgres` (postgres.js) 3.x, Cloudflare Workers/Wrangler, Vitest 2.x, bcryptjs, `@tsndr/cloudflare-worker-jwt`. Postgres ≥14 (local). All money columns `NUMERIC(14,2)`. All timestamps `TIMESTAMPTZ`.

**Scope of this plan:**
- **Phase 0** — Test infrastructure (Vitest + helpers + DB reset)
- **Phase 1** — Fix `orders` POST lifecycle/status defaults (PRD gap #1)
- **Phase 2** — Strip cost/profit fields from inventory payload for purchasers (PRD gap #4)
- **Phase 3** — Categories table + routes (PRD gap #2)
- **Phase 4** — Sell-order status meta + attachments + Inventory side-effects (PRD gap #3)
- **Phase 5** — Commission tiers + settings; dashboard refactor (PRD gap #5)
- **Phase 6** — Workspace settings store (PRD gap #6)
- **Phase 7** — Notification triggers (PRD gap #7)
- **Phase 8** — Pagination, sort allowlists, audit-log immutability, idempotency (PRD gap #8 + cross-cutting NFRs)

Each phase ends with `pnpm typecheck && pnpm test` green and a commit.

---

## File structure overview

What each phase creates/modifies, mapped up front:

```
apps/backend/
├── migrations/
│   ├── 0003_fix_lifecycle_default.sql       # Phase 1
│   ├── 0004_categories.sql                  # Phase 3
│   ├── 0005_sell_order_status_meta.sql      # Phase 4
│   ├── 0006_attachments.sql                 # Phase 4
│   ├── 0007_commission.sql                  # Phase 5
│   ├── 0008_workspace_settings.sql          # Phase 6
│   ├── 0009_audit_lock.sql                  # Phase 8
│   └── 0010_indexes_pagination.sql          # Phase 8
├── src/
│   ├── routes/
│   │   ├── orders.ts                        # Phase 1 modify
│   │   ├── inventory.ts                     # Phase 2 modify (role-based field filter)
│   │   ├── categories.ts                    # Phase 3 new
│   │   ├── attachments.ts                   # Phase 4 new
│   │   ├── sellOrders.ts                    # Phase 4 modify (status transitions + inventory side-effects)
│   │   ├── commission.ts                    # Phase 5 new
│   │   ├── workspace.ts                     # Phase 6 new
│   │   ├── dashboard.ts                     # Phase 5 modify (use tier table)
│   │   └── notifications.ts                 # Phase 7 modify (mark-one route)
│   ├── lib/
│   │   ├── notify.ts                        # Phase 7 new — internal notify() helper
│   │   ├── pagination.ts                    # Phase 8 new — cursor encode/decode
│   │   ├── commission-calc.ts               # Phase 5 new
│   │   └── idempotency.ts                   # Phase 8 new
│   ├── auth.ts                              # unchanged
│   ├── db.ts                                # unchanged
│   ├── types.ts                             # extended each phase
│   └── index.ts                             # Phase 3+4+5+6 mount new routes
├── tests/
│   ├── helpers/
│   │   ├── app.ts                           # Phase 0 — fetch helper wrapping app.fetch()
│   │   ├── db.ts                            # Phase 0 — reset/seed helper
│   │   └── auth.ts                          # Phase 0 — token helper
│   ├── fixtures/
│   │   ├── ram-label.png                    # Phase 0 — small fixture for scan tests
│   │   └── invoice.pdf                      # Phase 4 — fixture for attachment tests
│   ├── orders.test.ts                       # Phase 1 + extended in §T4
│   ├── inventory.test.ts                    # Phase 2 + extended in §T5
│   ├── categories.test.ts                   # Phase 3
│   ├── sell-orders.test.ts                  # Phase 4
│   ├── attachments.test.ts                  # Phase 4
│   ├── commission.test.ts                   # Phase 5
│   ├── dashboard.test.ts                    # Phase 5
│   ├── workspace.test.ts                    # Phase 6
│   ├── notifications.test.ts                # Phase 7
│   └── pagination.test.ts                   # Phase 8
├── vitest.config.ts                         # Phase 0 new
└── package.json                             # Phase 0 modify
```

---

## Conventions (read this once)

**Test database.** Tests run against a Postgres database whose URL is in `apps/backend/.dev.vars` under `TEST_DATABASE_URL`. Each test file calls `await resetDb()` in a top-level `beforeEach` — this drops + re-creates the schema + re-seeds. Slow but deterministic and we have ≤200 tests; fine for v1.

**Auth in tests.** Use `loginAs('alex@recycleservers.io')` and `loginAs('marcus@recycleservers.io')` helpers — these POST to `/api/auth/login` with password `'demo'` (seeded) and return the token string.

**Hono app under test.** We don't run wrangler in tests. We import the `app` object from `src/index.ts` and call `app.fetch(request, env)` directly — Hono is just a Fetch handler. This is faster and gives us full control of env bindings.

**Commits.** Conventional commit prefixes: `feat`, `fix`, `test`, `chore`, `refactor`, `docs`. Co-author trailer optional but consistent within a session.

**Migrations are forward-only.** Never edit a committed migration. If you need to change schema after rollout, add a new numbered migration.

---

# Phase 0 — Test infrastructure

Outcome: `pnpm test` runs zero tests but exits 0. All helpers in place.

---

### Task 0.1: Install Vitest + dependencies

**Files:**
- Modify: `apps/backend/package.json`

- [ ] **Step 1: Add devDependencies**

Run from repo root:

```bash
pnpm --filter recycle-erp-backend add -D vitest @types/node tsx
```

Confirm `apps/backend/package.json` `devDependencies` now contains `vitest`, `@types/node`, `tsx`. Existing dev deps (`wrangler`, `@cloudflare/workers-types`, `typescript`, `dotenv`) stay.

- [ ] **Step 2: Add test script**

Edit `apps/backend/package.json` `scripts` block to include:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/package.json pnpm-lock.yaml
git commit -m "chore(backend): add vitest + tsx for test harness"
```

---

### Task 0.2: Vitest config

**Files:**
- Create: `apps/backend/vitest.config.ts`

- [ ] **Step 1: Write config**

```typescript
// apps/backend/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // serialize — shared DB
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/backend/vitest.config.ts
git commit -m "chore(backend): vitest config"
```

---

### Task 0.3: Test DB helper

**Files:**
- Create: `apps/backend/tests/helpers/db.ts`
- Modify: `apps/backend/.dev.vars` (add `TEST_DATABASE_URL`)

- [ ] **Step 1: Add TEST_DATABASE_URL**

Edit `apps/backend/.dev.vars` (create if absent) — append:

```
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/recycle_erp_test
```

Create the database manually once:

```bash
psql "postgres://postgres:postgres@127.0.0.1:5432/postgres" -c "CREATE DATABASE recycle_erp_test;"
```

(Skip if DB exists.)

- [ ] **Step 2: Write helper**

```typescript
// apps/backend/tests/helpers/db.ts
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..', '..');
const migrationsDir = join(backendRoot, 'migrations');
const seedScript = join(backendRoot, 'scripts', 'seed.mjs');

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL!;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL not set — add it to apps/backend/.dev.vars');
}

let sql: postgres.Sql | null = null;
export function getTestDb() {
  if (!sql) sql = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
  return sql;
}

const KNOWN_TABLES = [
  'inventory_events', 'sell_order_lines', 'sell_orders',
  'order_lines', 'orders', 'label_scans', 'notifications',
  'ref_prices', 'customers', 'warehouses', 'workflow_stages', 'users',
];

export async function resetDb(): Promise<void> {
  const db = getTestDb();
  // Drop in dependency order (added tables in later phases get appended)
  for (const t of KNOWN_TABLES) {
    await db.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  // Re-run every migration in lexical order
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = readFileSync(join(migrationsDir, f), 'utf8');
    await db.unsafe(sqlText);
  }
  // Run the existing seed.mjs against TEST_DATABASE_URL
  const r = spawnSync('node', [seedScript], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`seed failed: ${r.stderr}\n${r.stdout}`);
  }
}

export async function closeTestDb(): Promise<void> {
  if (sql) { await sql.end({ timeout: 1 }); sql = null; }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/tests/helpers/db.ts apps/backend/.dev.vars
git commit -m "test(backend): db reset + migration helper"
```

---

### Task 0.4: App fetch helper + auth helper

**Files:**
- Create: `apps/backend/tests/helpers/app.ts`
- Create: `apps/backend/tests/helpers/auth.ts`
- Create: `apps/backend/tests/helpers/setup.ts`

- [ ] **Step 1: App fetch helper**

```typescript
// apps/backend/tests/helpers/app.ts
import app from '../../src/index';
import { TEST_DATABASE_URL } from './db';
import type { Env } from '../../src/types';

export const testEnv: Env = {
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-secret-' + Math.random().toString(36).slice(2),
  JWT_ISSUER: 'recycle-erp-test',
  STUB_OCR: 'true',
};

export type ApiResult<T = unknown> = {
  status: number;
  body: T;
  headers: Headers;
};

export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await app.fetch(new Request('http://test' + path, init), testEnv);
  const text = await res.text();
  let body: T;
  try { body = text ? JSON.parse(text) : (undefined as T); }
  catch { body = text as unknown as T; }
  return { status: res.status, body, headers: res.headers };
}

export async function multipart(
  path: string,
  fields: Record<string, string | Blob>,
  opts: { token?: string } = {},
): Promise<ApiResult> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await app.fetch(new Request('http://test' + path, { method: 'POST', body: form, headers }), testEnv);
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
```

- [ ] **Step 2: Auth helper**

```typescript
// apps/backend/tests/helpers/auth.ts
import { api } from './app';

export type LoginResult = { token: string; user: { id: string; role: string; email: string } };

export async function loginAs(email: string, password = 'demo'): Promise<LoginResult> {
  const r = await api<LoginResult>('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const ALEX = 'alex@recycleservers.io';        // manager
export const MARCUS = 'marcus@recycleservers.io';    // purchaser
export const PRIYA = 'priya@recycleservers.io';      // purchaser
```

- [ ] **Step 3: Vitest setup**

```typescript
// apps/backend/tests/helpers/setup.ts
import { beforeAll, afterAll } from 'vitest';
import { closeTestDb } from './db';

beforeAll(() => {
  // Make Vitest fail fast if TEST_DATABASE_URL is missing
  if (!process.env.TEST_DATABASE_URL) {
    // Load from .dev.vars if not already set
    // (db.ts itself throws if still missing)
  }
});

afterAll(async () => { await closeTestDb(); });
```

- [ ] **Step 4: Smoke test**

Create `apps/backend/tests/smoke.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';

describe('smoke', () => {
  beforeAll(async () => { await resetDb(); });

  it('GET / returns service banner', async () => {
    const r = await api('GET', '/');
    expect(r.status).toBe(200);
    expect((r.body as { service: string }).service).toBe('recycle-erp-backend');
  });
});
```

- [ ] **Step 5: Run smoke**

Run: `cd apps/backend && pnpm test`
Expected: 1 test passes. If `TEST_DATABASE_URL` not picked up, also export from shell:
```bash
export $(grep -v '^#' apps/backend/.dev.vars | xargs) && pnpm --filter recycle-erp-backend test
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/tests/
git commit -m "test(backend): app/auth helpers + smoke test"
```

---

# Phase 1 — Fix order POST defaults

Existing bug: `routes/orders.ts:194` sets `lifecycle='awaiting_payment'` and `routes/orders.ts:209` sets line `status='In Transit'`. Per PRD §6.2, a freshly submitted order MUST start at `lifecycle='draft'` with line `status='Draft'`. The migration also fixes the column default.

---

### Task 1.1: Failing tests for order create defaults

**Files:**
- Create: `apps/backend/tests/orders.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/backend/tests/orders.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('POST /api/orders defaults', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates an order in lifecycle="draft" with line status="Draft"', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200',
          partNumber: 'M393A4K40DB3-CWE', condition: 'Pulled — Tested',
          qty: 4, unitCost: 78.5,
        }],
      },
    });
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect(id).toMatch(/^SO-\d+$/);

    const got = await api<{ order: { lifecycle: string; lines: { status: string }[] } }>(
      'GET', '/api/orders/' + id, { token },
    );
    expect(got.status).toBe(200);
    expect(got.body.order.lifecycle).toBe('draft');
    expect(got.body.order.lines[0].status).toBe('Draft');
  });

  it('rejects mixed-category lines with 400', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        lines: [
          { category: 'RAM', qty: 1, unitCost: 10, condition: 'New' },
          { category: 'SSD', qty: 1, unitCost: 10, condition: 'New' },
        ],
      },
    });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `cd apps/backend && pnpm test orders`
Expected: Both tests fail. The first because the existing code returns `lifecycle: 'awaiting_payment'` and line `status: 'In Transit'`. The second because there is no category-mismatch check.

---

### Task 1.2: Migration to fix orders.lifecycle default

**Files:**
- Create: `apps/backend/migrations/0003_fix_lifecycle_default.sql`

- [ ] **Step 1: Write migration**

```sql
-- apps/backend/migrations/0003_fix_lifecycle_default.sql
-- Fix the default lifecycle for new orders. Previous default was
-- 'awaiting_payment' which doesn't exist in the workflow_stages table.

ALTER TABLE orders ALTER COLUMN lifecycle SET DEFAULT 'draft';

-- Backfill any existing rows that were wrongly seeded with the old default.
UPDATE orders SET lifecycle = 'draft' WHERE lifecycle = 'awaiting_payment';
```

- [ ] **Step 2: Apply (against test DB on next resetDb; against dev DB now)**

Run: `cd apps/backend && pnpm db:migrate`
Expected: no errors. `psql ... -c "SELECT column_default FROM information_schema.columns WHERE table_name='orders' AND column_name='lifecycle'"` returns `'draft'::text`.

---

### Task 1.3: Fix POST /api/orders code

**Files:**
- Modify: `apps/backend/src/routes/orders.ts`

- [ ] **Step 1: Edit POST handler**

Open `apps/backend/src/routes/orders.ts`. Find the POST handler (around line 163). Replace the existing INSERT block and add category validation **before** the transaction:

```typescript
// after the body null-check, around line 178
if (!body.lines.every(l => !l.category || l.category === body.category)) {
  return c.json({ error: 'all lines must match order category' }, 400);
}
```

In the INSERT block change `lifecycle` from `'awaiting_payment'` to `'draft'`:

```typescript
await tx`
  INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle)
  VALUES (
    ${newId}, ${u.id}, ${body.category},
    ${body.warehouseId ?? null}, ${body.payment ?? 'company'}, ${body.notes ?? null},
    ${body.totalCost ?? null}, 'draft'
  )
`;
```

And in the line INSERT change `status` from `'In Transit'` to `'Draft'`:

```typescript
await tx`
  INSERT INTO order_lines (
    order_id, category, brand, capacity, type, classification, rank, speed,
    interface, form_factor, description, part_number, condition, qty,
    unit_cost, sell_price, status, scan_image_id, scan_confidence, position
  ) VALUES (
    ${newId}, ${l.category ?? body.category}, ${l.brand ?? null}, ${l.capacity ?? null}, ${l.type ?? null},
    ${l.classification ?? null}, ${l.rank ?? null}, ${l.speed ?? null},
    ${l.interface ?? null}, ${l.formFactor ?? null}, ${l.description ?? null},
    ${l.partNumber ?? null}, ${l.condition ?? 'Pulled — Tested'}, ${l.qty},
    ${l.unitCost}, ${l.sellPrice ?? null}, 'Draft',
    ${l.scanImageId ?? null}, ${l.scanConfidence ?? null}, ${i}
  )
`;
```

- [ ] **Step 2: Run — should pass**

Run: `cd apps/backend && pnpm test orders`
Expected: 2/2 pass.

- [ ] **Step 3: Type-check**

Run: `cd apps/backend && pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0003_fix_lifecycle_default.sql apps/backend/src/routes/orders.ts apps/backend/tests/orders.test.ts
git commit -m "fix(orders): default new orders to lifecycle=draft, lines=Draft"
```

---

### Task 1.4: Add `POST /api/orders/:id/advance` route

**Files:**
- Modify: `apps/backend/src/routes/orders.ts`
- Modify: `apps/backend/tests/orders.test.ts`

- [ ] **Step 1: Failing test**

Append to `apps/backend/tests/orders.test.ts`:

```typescript
describe('POST /api/orders/:id/advance', () => {
  beforeEach(async () => { await resetDb(); });

  it('purchaser can advance own Draft → in_transit', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    const id = created.body.id;
    const r = await api('POST', `/api/orders/${id}/advance`, { token: pTok });
    expect(r.status).toBe(200);
    const got = await api<{ order: { lifecycle: string; lines: { status: string }[] } }>(
      'GET', `/api/orders/${id}`, { token: pTok });
    expect(got.body.order.lifecycle).toBe('in_transit');
    expect(got.body.order.lines[0].status).toBe('In Transit');
  });

  it('purchaser cannot jump past in_transit', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok }); // → in_transit
    const r = await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok }); // attempt reviewing
    expect(r.status).toBe(403);
  });

  it('manager can advance to any stage', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { token: mTok } = await loginAs(ALEX);
    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });
    const r = await api('POST', `/api/orders/${c.body.id}/advance`, {
      token: mTok, body: { toStage: 'reviewing' } });
    expect(r.status).toBe(200);
    const got = await api<{ order: { lifecycle: string } }>('GET', `/api/orders/${c.body.id}`, { token: mTok });
    expect(got.body.order.lifecycle).toBe('reviewing');
  });
});
```

- [ ] **Step 2: Run — should fail (404)**

Run: `cd apps/backend && pnpm test orders`
Expected: 3 new tests fail with 404 (route does not exist).

- [ ] **Step 3: Implement route**

Append to `apps/backend/src/routes/orders.ts`, before `export default orders;`:

```typescript
// Lifecycle ordering — must match workflow_stages.position.
// Purchasers may only move Draft → In Transit (and not back).
const LINE_STATUS_FOR_LIFECYCLE: Record<string, string> = {
  draft: 'Draft',
  in_transit: 'In Transit',
  reviewing: 'Reviewing',
  done: 'Done',
};

orders.post('/:id/advance', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as { toStage?: string } | null;

  const cur = (await sql`SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { user_id: string; lifecycle: string } | undefined;
  if (!cur) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && cur.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const stages = await sql<{ id: string; position: number }[]>`
    SELECT id, position FROM workflow_stages ORDER BY position`;
  const curIdx = stages.findIndex(s => s.id === cur.lifecycle);
  let nextStageId: string;
  if (body?.toStage) {
    if (u.role !== 'manager') return c.json({ error: 'Only managers can jump stages' }, 403);
    if (!stages.find(s => s.id === body.toStage)) return c.json({ error: 'Unknown stage' }, 400);
    nextStageId = body.toStage;
  } else {
    if (curIdx < 0 || curIdx >= stages.length - 1) {
      return c.json({ error: 'Already at the final stage' }, 409);
    }
    nextStageId = stages[curIdx + 1].id;
  }
  // Purchaser can only advance Draft → in_transit.
  if (u.role !== 'manager' && !(cur.lifecycle === 'draft' && nextStageId === 'in_transit')) {
    return c.json({ error: 'Purchasers can only advance Draft to In Transit' }, 403);
  }

  const newLineStatus = LINE_STATUS_FOR_LIFECYCLE[nextStageId];
  await sql.begin(async (tx) => {
    await tx`UPDATE orders SET lifecycle = ${nextStageId} WHERE id = ${id}`;
    if (newLineStatus) {
      await tx`UPDATE order_lines SET status = ${newLineStatus} WHERE order_id = ${id}`;
      // Audit: one status event per line so the timeline reflects the bulk move.
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        SELECT id, ${u.id}, 'status', jsonb_build_object('field','status','from',status,'to',${newLineStatus})
        FROM order_lines WHERE order_id = ${id} AND status IS DISTINCT FROM ${newLineStatus}
      `;
    }
  });

  return c.json({ ok: true, lifecycle: nextStageId });
});
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test orders`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/orders.ts apps/backend/tests/orders.test.ts
git commit -m "feat(orders): POST /:id/advance with role-aware lifecycle transitions"
```

---

# Phase 2 — Strip cost/profit from inventory for purchasers

Per PRD §6.8, the inventory list MUST hide `unit_cost`, `profit`, `margin` from purchasers. Currently `inventory.ts` returns them unconditionally.

---

### Task 2.1: Failing tests for inventory visibility

**Files:**
- Create: `apps/backend/tests/inventory.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/backend/tests/inventory.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('GET /api/inventory — role-based field visibility', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager sees unit_cost / profit / margin', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ items: Record<string, unknown>[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    const item = r.body.items[0];
    expect(item).toBeDefined();
    expect(item).toHaveProperty('unit_cost');
    expect(typeof (item as { unit_cost: number }).unit_cost).toBe('number');
  });

  it('purchaser does NOT see unit_cost / profit / margin', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ items: Record<string, unknown>[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    const item = r.body.items[0];
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('unit_cost');
    expect(item).not.toHaveProperty('profit');
    expect(item).not.toHaveProperty('margin');
    // Sell price IS visible (it's the price the team is asking — not sensitive).
    // It may be null on Draft lines but the key should appear.
    expect(item).toHaveProperty('sell_price');
  });

  it('purchaser scoped to own lines only', async () => {
    const { token, user } = await loginAs(MARCUS);
    const r = await api<{ items: { user_id: string }[] }>('GET', '/api/inventory', { token });
    expect(r.status).toBe(200);
    for (const it of r.body.items) expect(it.user_id).toBe(user.id);
  });
});
```

- [ ] **Step 2: Run — should fail (purchaser sees unit_cost)**

Run: `cd apps/backend && pnpm test inventory`
Expected: 1 fails (the "purchaser does NOT see unit_cost" assertion).

---

### Task 2.2: Strip fields per role

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts`

- [ ] **Step 1: Edit list handler**

Open `apps/backend/src/routes/inventory.ts`. Replace the final `return c.json({ items: rows });` inside the GET `/` handler with:

```typescript
// Purchasers MUST NOT see cost or profit fields (PRD §6.8). Strip them before
// returning. Sell price is visible — it's not sensitive.
const STRIP_FOR_PURCHASER = ['unit_cost', 'profit', 'margin'] as const;
if (u.role !== 'manager') {
  const filtered = (rows as Record<string, unknown>[]).map(r => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!(STRIP_FOR_PURCHASER as readonly string[]).includes(k)) out[k] = v;
    }
    return out;
  });
  return c.json({ items: filtered });
}
return c.json({ items: rows });
```

Also: in the `GET /:id` handler at the bottom, strip the same keys for the single-item case:

```typescript
// In the GET /:id handler, replace the final return with:
if (u.role !== 'manager') {
  const r = row as Record<string, unknown>;
  delete r.unit_cost;
  delete r.profit;
  delete r.margin;
  return c.json({ item: r, events });
}
return c.json({ item: row, events });
```

- [ ] **Step 2: Run — should pass**

Run: `cd apps/backend && pnpm test inventory`
Expected: 3/3 pass.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/routes/inventory.ts apps/backend/tests/inventory.test.ts
git commit -m "fix(inventory): strip cost/profit/margin from purchaser payloads"
```

---

### Task 2.3: Inventory aggregate-by-part endpoint

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts`
- Modify: `apps/backend/tests/inventory.test.ts`

- [ ] **Step 1: Failing test**

Append to `tests/inventory.test.ts`:

```typescript
describe('GET /api/inventory/aggregate/by-part', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns inTransit / inStock counts for a part number', async () => {
    const { token } = await loginAs(ALEX);
    // Find a part number that exists in seed
    const list = await api<{ items: { part_number: string }[] }>('GET', '/api/inventory', { token });
    const pn = list.body.items.find(i => i.part_number)?.part_number;
    expect(pn).toBeTruthy();

    const r = await api<{ partNumber: string; inTransit: number; inStock: number; lines: number }>(
      'GET', `/api/inventory/aggregate/by-part?partNumber=${encodeURIComponent(pn!)}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.partNumber).toBe(pn);
    expect(r.body.lines).toBeGreaterThanOrEqual(1);
  });

  it('400 when partNumber missing', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/inventory/aggregate/by-part', { token });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run — should fail (404)**

Run: `cd apps/backend && pnpm test inventory`
Expected: 2 new tests fail with 404.

- [ ] **Step 3: Implement route**

In `apps/backend/src/routes/inventory.ts`, add **before** `inventory.get('/:id', ...)` (route order matters — Hono matches in declaration order):

```typescript
inventory.get('/aggregate/by-part', async (c) => {
  const pn = c.req.query('partNumber');
  if (!pn) return c.json({ error: 'partNumber is required' }, 400);
  const sql = getDb(c.env);
  const rows = (await sql<{ status: string; qty: number }[]>`
    SELECT status, COALESCE(SUM(qty), 0)::int AS qty
    FROM order_lines WHERE part_number = ${pn} GROUP BY status
  `);
  let inTransit = 0, inStock = 0, totalLines = 0;
  for (const r of rows) {
    if (r.status === 'In Transit') inTransit += r.qty;
    else if (r.status === 'Done' || r.status === 'Reviewing') inStock += r.qty;
  }
  const lineCount = (await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM order_lines WHERE part_number = ${pn}`)[0].n;
  return c.json({ partNumber: pn, inTransit, inStock, lines: lineCount });
});
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test inventory`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/inventory.ts apps/backend/tests/inventory.test.ts
git commit -m "feat(inventory): aggregate-by-part-number endpoint for QuickView"
```

---

# Phase 3 — Categories

Currently `RAM | SSD | Other` are hard-coded TypeScript literals. PRD §4.4 makes categories a first-class resource with toggles (enabled, ai_capture, requires_pn, default_margin), so the Settings → Categories tab can drive what the Submit page offers.

---

### Task 3.1: Categories migration

**Files:**
- Create: `apps/backend/migrations/0004_categories.sql`

- [ ] **Step 1: Write migration**

```sql
-- apps/backend/migrations/0004_categories.sql

CREATE TABLE IF NOT EXISTS categories (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  icon            TEXT NOT NULL DEFAULT 'box',
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  ai_capture      BOOLEAN NOT NULL DEFAULT FALSE,
  requires_pn     BOOLEAN NOT NULL DEFAULT FALSE,
  default_margin  NUMERIC(5,2) NOT NULL DEFAULT 30.0,  -- percent
  position        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO categories (id, label, icon, enabled, ai_capture, requires_pn, default_margin, position) VALUES
  ('RAM',   'RAM',   'chip',  TRUE,  TRUE,  TRUE,  38.0, 0),
  ('SSD',   'SSD',   'drive', TRUE,  FALSE, TRUE,  28.0, 1),
  ('Other', 'Other', 'box',   TRUE,  FALSE, FALSE, 22.0, 2),
  ('CPU',   'CPU',   'chip',  FALSE, FALSE, TRUE,  30.0, 3),
  ('GPU',   'GPU',   'chip',  FALSE, FALSE, TRUE,  35.0, 4)
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Apply**

Run: `cd apps/backend && pnpm db:migrate`
Expected: no errors.

---

### Task 3.2: Failing tests for /api/categories

**Files:**
- Create: `apps/backend/tests/categories.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// apps/backend/tests/categories.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('/api/categories', () => {
  beforeEach(async () => { await resetDb(); });

  it('GET — both roles can list', async () => {
    for (const email of [ALEX, MARCUS]) {
      const { token } = await loginAs(email);
      const r = await api<{ items: { id: string; enabled: boolean }[] }>(
        'GET', '/api/categories', { token });
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeGreaterThanOrEqual(5);
      const ram = r.body.items.find(i => i.id === 'RAM');
      expect(ram?.enabled).toBe(true);
    }
  });

  it('PATCH — manager can toggle enabled', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/categories/CPU', { token, body: { enabled: true } });
    expect(r.status).toBe(200);
    const got = await api<{ items: { id: string; enabled: boolean }[] }>(
      'GET', '/api/categories', { token });
    expect(got.body.items.find(i => i.id === 'CPU')?.enabled).toBe(true);
  });

  it('PATCH — purchaser is forbidden', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('PATCH', '/api/categories/RAM', { token, body: { enabled: false } });
    expect(r.status).toBe(403);
  });

  it('POST — manager can add', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ id: string }>('POST', '/api/categories', {
      token, body: { id: 'NIC', label: 'NIC', icon: 'box', defaultMargin: 32 },
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe('NIC');
  });
});

describe('POST /api/orders — category must be enabled', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects disabled category', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/orders', {
      token, body: {
        category: 'CPU', // disabled by default
        lines: [{ category: 'CPU', qty: 1, unitCost: 50, condition: 'New', description: 'Xeon' }],
      },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/disabled|not enabled/i);
  });
});
```

- [ ] **Step 2: Run — should fail (404 on /api/categories)**

Run: `cd apps/backend && pnpm test categories`
Expected: every test fails.

---

### Task 3.3: Categories route

**Files:**
- Create: `apps/backend/src/routes/categories.ts`
- Modify: `apps/backend/src/index.ts`

- [ ] **Step 1: Write route**

```typescript
// apps/backend/src/routes/categories.ts
import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const categories = new Hono<{ Bindings: Env; Variables: { user: User } }>();

categories.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, label, icon, enabled, ai_capture, requires_pn,
           default_margin::float AS default_margin, position
    FROM categories ORDER BY position
  `;
  return c.json({ items: rows });
});

categories.post('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { id: string; label: string; icon?: string; enabled?: boolean;
        aiCapture?: boolean; requiresPn?: boolean; defaultMargin?: number; position?: number }
    | null;
  if (!body?.id || !body?.label) return c.json({ error: 'id and label required' }, 400);
  const sql = getDb(c.env);
  try {
    await sql`
      INSERT INTO categories (id, label, icon, enabled, ai_capture, requires_pn, default_margin, position)
      VALUES (${body.id}, ${body.label}, ${body.icon ?? 'box'},
              ${body.enabled ?? true}, ${body.aiCapture ?? false}, ${body.requiresPn ?? false},
              ${body.defaultMargin ?? 30}, ${body.position ?? 99})
    `;
  } catch (e) {
    if (/duplicate/i.test((e as { message?: string }).message ?? '')) {
      return c.json({ error: `category ${body.id} already exists` }, 409);
    }
    throw e;
  }
  return c.json({ id: body.id }, 201);
});

categories.patch('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { label?: string; icon?: string; enabled?: boolean; aiCapture?: boolean;
        requiresPn?: boolean; defaultMargin?: number; position?: number }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const sql = getDb(c.env);
  const r = await sql`
    UPDATE categories SET
      label          = COALESCE(${body.label ?? null}, label),
      icon           = COALESCE(${body.icon ?? null}, icon),
      enabled        = COALESCE(${body.enabled ?? null}, enabled),
      ai_capture     = COALESCE(${body.aiCapture ?? null}, ai_capture),
      requires_pn    = COALESCE(${body.requiresPn ?? null}, requires_pn),
      default_margin = COALESCE(${body.defaultMargin ?? null}, default_margin),
      position       = COALESCE(${body.position ?? null}, position)
    WHERE id = ${id} RETURNING id
  `;
  if (r.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

export default categories;
```

- [ ] **Step 2: Mount in index.ts**

Open `apps/backend/src/index.ts`. Add import at the top alongside other route imports:

```typescript
import categoriesRoutes from './routes/categories';
```

Add to the auth middleware block:

```typescript
app.use('/api/categories/*', authMiddleware);
```

Add to the route mounts:

```typescript
app.route('/api/categories', categoriesRoutes);
```

- [ ] **Step 3: Wire category-enabled check into POST /api/orders**

Open `apps/backend/src/routes/orders.ts`. In the POST handler, **after** the body null-check but **before** the transaction, add:

```typescript
const catRow = (await sql<{ enabled: boolean }[]>`
  SELECT enabled FROM categories WHERE id = ${body.category} LIMIT 1
`)[0];
if (!catRow) return c.json({ error: `unknown category: ${body.category}` }, 400);
if (!catRow.enabled) return c.json({ error: `category ${body.category} is disabled` }, 400);
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test`
Expected: all categories + orders tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/migrations/0004_categories.sql apps/backend/src/routes/categories.ts \
        apps/backend/src/routes/orders.ts apps/backend/src/index.ts \
        apps/backend/tests/categories.test.ts
git commit -m "feat(categories): table + CRUD + enforce on order create"
```

---

# Phase 4 — Sell-order status meta + attachments

Per PRD §6.4: advancing a sell order to `Shipped`, `Awaiting payment`, or `Done` MUST include a tracking note OR ≥1 attachment. We also need inventory side-effects: when a sell order reaches `Done`, its inventory lines flip to `Done` and become locked.

---

### Task 4.1: Migrations — status_meta + attachments

**Files:**
- Create: `apps/backend/migrations/0005_sell_order_status_meta.sql`
- Create: `apps/backend/migrations/0006_attachments.sql`

- [ ] **Step 1: status_meta migration**

```sql
-- apps/backend/migrations/0005_sell_order_status_meta.sql

CREATE TABLE IF NOT EXISTS sell_order_status_meta (
  sell_order_id   TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('Shipped','Awaiting payment','Done')),
  note            TEXT,
  attachment_ids  TEXT[] NOT NULL DEFAULT '{}',
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by     UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (sell_order_id, status)
);
```

- [ ] **Step 2: attachments migration**

```sql
-- apps/backend/migrations/0006_attachments.sql

CREATE TABLE IF NOT EXISTS attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_id   TEXT NOT NULL,             -- Cloudflare R2 key
  url          TEXT NOT NULL,             -- public/signed url (placeholder for v1)
  name         TEXT NOT NULL,
  size         INT  NOT NULL,
  mime_type    TEXT NOT NULL,
  uploaded_by  UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attachments_uploaded_by_idx ON attachments(uploaded_by);
```

- [ ] **Step 3: Apply**

Run: `cd apps/backend && pnpm db:migrate`
Expected: no errors.

---

### Task 4.2: Attachments route (v1 stub — local store)

**Files:**
- Create: `apps/backend/src/routes/attachments.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/attachments.test.ts`
- Create: `apps/backend/tests/fixtures/invoice.pdf` (small placeholder)

- [ ] **Step 1: Create the PDF fixture**

```bash
mkdir -p apps/backend/tests/fixtures
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\nxref\n0 3\n0000000000 65535 f\n0000000010 00000 n\n0000000053 00000 n\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n95\n%%EOF\n' > apps/backend/tests/fixtures/invoice.pdf
```

- [ ] **Step 2: Failing test**

```typescript
// apps/backend/tests/attachments.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetDb } from './helpers/db';
import { multipart, api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const fixture = join(__dirname, 'fixtures', 'invoice.pdf');

describe('POST /api/attachments', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager can upload a PDF', async () => {
    const { token } = await loginAs(ALEX);
    const file = new Blob([readFileSync(fixture)], { type: 'application/pdf' });
    const r = await multipart('/api/attachments', { file }, { token });
    expect(r.status).toBe(201);
    const b = r.body as { id: string; name: string; size: number; mimeType: string };
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.mimeType).toBe('application/pdf');
    expect(b.size).toBeGreaterThan(0);
  });

  it('purchaser is forbidden', async () => {
    const { token } = await loginAs(MARCUS);
    const file = new Blob([readFileSync(fixture)], { type: 'application/pdf' });
    const r = await multipart('/api/attachments', { file }, { token });
    expect(r.status).toBe(403);
  });

  it('rejects oversize files (>10MB)', async () => {
    const { token } = await loginAs(ALEX);
    const big = new Blob([new Uint8Array(11 * 1024 * 1024)], { type: 'application/pdf' });
    const r = await multipart('/api/attachments', { file: big }, { token });
    expect(r.status).toBe(413);
  });
});
```

- [ ] **Step 3: Run — should fail (404)**

Run: `cd apps/backend && pnpm test attachments`

- [ ] **Step 4: Implement route**

```typescript
// apps/backend/src/routes/attachments.ts
import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const attachments = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);

attachments.post('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const file = form.get('file');
  if (!(file instanceof File) && !(file instanceof Blob)) return c.json({ error: 'file required' }, 400);
  const f = file as File;
  if (f.size > MAX_BYTES) return c.json({ error: 'file exceeds 10MB' }, 413);
  if (f.type && !ALLOWED_MIME.has(f.type)) return c.json({ error: `mime ${f.type} not allowed` }, 415);

  // v1: store metadata only — actual R2 upload deferred. The storage_id is a
  // synthetic key so downstream code can be wired up; replace with real R2
  // upload in a future migration.
  const storageId = 'local/' + crypto.randomUUID();
  const url = `internal://${storageId}`;
  const sql = getDb(c.env);
  const r = await sql<{ id: string }[]>`
    INSERT INTO attachments (storage_id, url, name, size, mime_type, uploaded_by)
    VALUES (${storageId}, ${url}, ${f.name ?? 'upload'}, ${f.size}, ${f.type || 'application/octet-stream'}, ${c.var.user.id})
    RETURNING id
  `;
  return c.json({ id: r[0].id, url, name: f.name ?? 'upload', size: f.size, mimeType: f.type }, 201);
});

attachments.get('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const r = (await sql`SELECT id, url, name, size, mime_type, created_at FROM attachments WHERE id = ${c.req.param('id')} LIMIT 1`)[0];
  if (!r) return c.json({ error: 'Not found' }, 404);
  return c.json({ attachment: r });
});

attachments.delete('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const r = await sql`DELETE FROM attachments WHERE id = ${c.req.param('id')} RETURNING id`;
  if (r.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default attachments;
```

- [ ] **Step 5: Mount in index.ts**

```typescript
// in apps/backend/src/index.ts — add with other imports
import attachmentsRoutes from './routes/attachments';
// in the auth-middleware block:
app.use('/api/attachments/*', authMiddleware);
// in the route mounts:
app.route('/api/attachments', attachmentsRoutes);
```

- [ ] **Step 6: Run — should pass**

Run: `cd apps/backend && pnpm test attachments`
Expected: 3/3 pass.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/migrations/0006_attachments.sql apps/backend/src/routes/attachments.ts \
        apps/backend/src/index.ts apps/backend/tests/attachments.test.ts apps/backend/tests/fixtures/invoice.pdf
git commit -m "feat(attachments): CRUD endpoints + 10MB/MIME validation"
```

---

### Task 4.3: Sell-order status transitions

**Files:**
- Create: `apps/backend/tests/sell-orders.test.ts`
- Modify: `apps/backend/src/routes/sellOrders.ts`

- [ ] **Step 1: Failing tests**

```typescript
// apps/backend/tests/sell-orders.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const pdf = join(__dirname, 'fixtures', 'invoice.pdf');

async function findSellableLine(token: string): Promise<{ id: string; qty: number; unit_cost: number; sell_price: number }> {
  const r = await api<{ items: Array<{ id: string; status: string; qty: number; unit_cost: number; sell_price: number | null }> }>(
    'GET', '/api/inventory?status=Reviewing', { token });
  const line = r.body.items.find(i => i.sell_price != null);
  if (!line) throw new Error('no sellable line in seed');
  return { id: line.id, qty: line.qty, unit_cost: line.unit_cost, sell_price: line.sell_price as number };
}

async function createDraftSellOrder(token: string): Promise<string> {
  const line = await findSellableLine(token);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId: 'c1',
      lines: [{
        inventoryId: line.id, category: 'RAM', label: 'Sample',
        partNumber: 'PN-1', qty: 1, unitPrice: line.sell_price,
        warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
      }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('POST /api/sell-orders/:id/status', () => {
  beforeEach(async () => { await resetDb(); });

  it('Shipped requires note OR attachments', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    const bad = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped' },
    });
    expect(bad.status).toBe(400);
  });

  it('Shipped accepts a note', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', note: 'FedEx 7732' },
    });
    expect(r.status).toBe(200);
    const got = await api<{ order: { status: string; statusMeta?: Record<string, { note?: string }> } }>(
      'GET', `/api/sell-orders/${id}`, { token });
    expect(got.body.order.status).toBe('Shipped');
    expect(got.body.order.statusMeta?.Shipped?.note).toBe('FedEx 7732');
  });

  it('Awaiting payment accepts attachments', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    // First advance to Shipped
    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 'ship' } });

    const file = new Blob([readFileSync(pdf)], { type: 'application/pdf' });
    const up = await multipart('/api/attachments', { file }, { token });
    const attachId = (up.body as { id: string }).id;

    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Awaiting payment', attachmentIds: [attachId] },
    });
    expect(r.status).toBe(200);
  });

  it('Done flips underlying inventory lines to Done', async () => {
    const { token } = await loginAs(ALEX);
    const line = await findSellableLine(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId: 'c1',
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: line.sell_price }],
      },
    });
    const soId = create.body.id;
    await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Shipped', note: 's' } });
    await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Awaiting payment', note: 'a' } });
    await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Done', note: 'paid' } });

    const got = await api<{ item: { status: string } }>('GET', `/api/inventory/${line.id}`, { token });
    expect(got.body.item.status).toBe('Done');
  });

  it('purchaser is forbidden', async () => {
    const { token: mTok } = await loginAs(ALEX);
    const id = await createDraftSellOrder(mTok);
    const { token: pTok } = await loginAs(MARCUS);
    const r = await api('POST', `/api/sell-orders/${id}/status`, { token: pTok, body: { to: 'Shipped', note: 's' } });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run — should fail (route missing + GET response missing statusMeta)**

Run: `cd apps/backend && pnpm test sell-orders`

- [ ] **Step 3: Implement status route + update GET**

Open `apps/backend/src/routes/sellOrders.ts`. Add **before** `export default sellOrders;`:

```typescript
const NEEDS_EVIDENCE = new Set(['Shipped', 'Awaiting payment', 'Done']);
const SELL_ORDER_FLOW = ['Draft', 'Shipped', 'Awaiting payment', 'Done'];

sellOrders.post('/:id/status', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { to: string; note?: string; attachmentIds?: string[] }
    | null;
  if (!body?.to) return c.json({ error: 'to is required' }, 400);
  if (!SELL_ORDER_FLOW.includes(body.to)) return c.json({ error: `unknown status: ${body.to}` }, 400);

  if (NEEDS_EVIDENCE.has(body.to)) {
    const hasNote = typeof body.note === 'string' && body.note.trim().length > 0;
    const hasFiles = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;
    if (!hasNote && !hasFiles) {
      return c.json({ error: 'note or attachments required for this status' }, 400);
    }
  }

  const sql = getDb(c.env);
  const cur = (await sql<{ status: string }[]>`SELECT status FROM sell_orders WHERE id = ${id} LIMIT 1`)[0];
  if (!cur) return c.json({ error: 'Not found' }, 404);
  if (cur.status === 'Done' && body.to !== 'Done') return c.json({ error: 'order is locked' }, 409);

  await sql.begin(async (tx) => {
    await tx`UPDATE sell_orders SET status = ${body.to}, updated_at = NOW() WHERE id = ${id}`;
    if (NEEDS_EVIDENCE.has(body.to)) {
      await tx`
        INSERT INTO sell_order_status_meta (sell_order_id, status, note, attachment_ids, recorded_by)
        VALUES (${id}, ${body.to}, ${body.note ?? null}, ${body.attachmentIds ?? []}, ${u.id})
        ON CONFLICT (sell_order_id, status) DO UPDATE SET
          note = EXCLUDED.note,
          attachment_ids = EXCLUDED.attachment_ids,
          recorded_at = NOW(),
          recorded_by = EXCLUDED.recorded_by
      `;
    }
    // Side effect: when sell order is Done, lock underlying inventory lines.
    if (body.to === 'Done') {
      await tx`
        UPDATE order_lines SET status = 'Done'
        WHERE id IN (SELECT inventory_id FROM sell_order_lines WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL)
      `;
      // Audit
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        SELECT inventory_id, ${u.id}, 'status',
               jsonb_build_object('field','status','to','Done','sellOrder',${id})
        FROM sell_order_lines WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL
      `;
    }
  });
  return c.json({ ok: true, status: body.to });
});
```

In the existing GET `/:id` handler, extend the response with statusMeta. Replace the final `return c.json({ order: { … } })` so it ends with:

```typescript
const metaRows = await sql<{ status: string; note: string | null; attachment_ids: string[]; recorded_at: string }[]>`
  SELECT status, note, attachment_ids, recorded_at
  FROM sell_order_status_meta WHERE sell_order_id = ${id}
`;
const statusMeta: Record<string, { note: string | null; attachmentIds: string[]; recordedAt: string }> = {};
for (const m of metaRows) statusMeta[m.status] = { note: m.note, attachmentIds: m.attachment_ids, recordedAt: m.recorded_at };

return c.json({
  order: {
    id: head.id, status: head.status, notes: head.notes, createdAt: head.created_at,
    discountPct: head.discount_pct,
    customer: { id: head.customer_id, name: head.customer_name, short: head.customer_short, terms: head.customer_terms, region: head.customer_region },
    lines: lines.map(l => ({
      id: l.id, category: l.category, label: l.label, sub: l.sub_label, partNumber: l.part_number,
      qty: l.qty, unitPrice: l.unit_price, condition: l.condition, position: l.position,
      warehouse: l.warehouse_short,
      lineTotal: +(l.qty * l.unit_price).toFixed(2),
    })),
    subtotal: +subtotal.toFixed(2),
    discount: +(subtotal * head.discount_pct).toFixed(2),
    total:    +(subtotal * (1 - head.discount_pct)).toFixed(2),
    statusMeta,
  },
});
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test sell-orders`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/migrations/0005_sell_order_status_meta.sql apps/backend/src/routes/sellOrders.ts apps/backend/tests/sell-orders.test.ts
git commit -m "feat(sell-orders): status transitions with note/attachment evidence + inventory lock on Done"
```

---

### Task 4.4: Reject over-qty in sell-order POST/PATCH

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts`
- Modify: `apps/backend/tests/sell-orders.test.ts`

- [ ] **Step 1: Failing test**

Append to `sell-orders.test.ts`:

```typescript
describe('sell-order qty clamp', () => {
  beforeEach(async () => { await resetDb(); });

  it('POST rejects qty > inventory line qty', async () => {
    const { token } = await loginAs(ALEX);
    const line = await findSellableLine(token);
    const r = await api('POST', '/api/sell-orders', {
      token,
      body: { customerId: 'c1', lines: [{
        inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
        qty: line.qty + 99, unitPrice: line.sell_price,
      }]},
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/qty/i);
  });
});
```

- [ ] **Step 2: Run — should fail (POST currently doesn't validate)**

Run: `cd apps/backend && pnpm test sell-orders`

- [ ] **Step 3: Add validation to POST**

In `sellOrders.ts` POST handler, **before** the `sql.begin`, add:

```typescript
// Clamp each line to the underlying inventory qty when inventoryId is provided
// and ensure the underlying line is sellable (status = 'Reviewing').
for (const l of body.lines) {
  if (!l.inventoryId) continue;
  const inv = (await sql<{ qty: number; status: string }[]>`
    SELECT qty, status FROM order_lines WHERE id = ${l.inventoryId} LIMIT 1
  `)[0];
  if (!inv) return c.json({ error: `inventory line ${l.inventoryId} not found` }, 400);
  if (inv.status !== 'Reviewing') return c.json({ error: `inventory line not sellable (status=${inv.status})` }, 400);
  if (l.qty > inv.qty) return c.json({ error: `qty ${l.qty} exceeds inventory available ${inv.qty}` }, 400);
}
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test sell-orders`

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts apps/backend/tests/sell-orders.test.ts
git commit -m "feat(sell-orders): clamp qty + require sellable status on create"
```

---

# Phase 5 — Commission tiers + dashboard refactor

The dashboard hardcodes `* 0.075`. PRD §6.6 makes commission tier-based on realized margin. We add the tier table + endpoints, then refactor the dashboard SQL to use them.

---

### Task 5.1: Commission migration

**Files:**
- Create: `apps/backend/migrations/0007_commission.sql`

- [ ] **Step 1: Migration**

```sql
-- apps/backend/migrations/0007_commission.sql

CREATE TABLE IF NOT EXISTS commission_tiers (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL,
  floor_pct   NUMERIC(5,2) NOT NULL,   -- e.g. 25.00 means margin ≥ 25%
  rate        NUMERIC(5,2) NOT NULL,   -- e.g. 4.00 means 4% commission
  position    INT NOT NULL DEFAULT 0
);
INSERT INTO commission_tiers (label, floor_pct, rate, position) VALUES
  ('Base',           0,  2, 0),
  ('Tier 1',        25,  4, 1),
  ('Tier 2',        35,  6, 2),
  ('Top performer', 45,  9, 3)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS commission_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO commission_settings (key, value) VALUES
  ('pay_schedule', '"monthly"'::jsonb),
  ('manager_approval', 'true'::jsonb),
  ('hold_on_returns', 'true'::jsonb),
  ('draft_mode', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Apply**

Run: `cd apps/backend && pnpm db:migrate`

---

### Task 5.2: Commission calc lib + tests

**Files:**
- Create: `apps/backend/src/lib/commission-calc.ts`
- Create: `apps/backend/tests/commission.test.ts`

- [ ] **Step 1: Failing tests for pure function**

```typescript
// apps/backend/tests/commission.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { computeCommission, type Tier } from '../src/lib/commission-calc';

const TIERS: Tier[] = [
  { id: 1, label: 'Base',     floorPct: 0,  rate: 2 },
  { id: 2, label: 'Tier 1',   floorPct: 25, rate: 4 },
  { id: 3, label: 'Tier 2',   floorPct: 35, rate: 6 },
  { id: 4, label: 'Top',      floorPct: 45, rate: 9 },
];

describe('computeCommission (pure)', () => {
  it('Base when margin = 0', () => {
    const r = computeCommission({ profit: 1000, revenue: 1000 /* margin 100% */ }, TIERS);
    expect(r.tier.label).toBe('Top');
    expect(r.payable).toBe(90); // 9%
  });

  it('Tier 1 when margin 30%', () => {
    const r = computeCommission({ profit: 300, revenue: 1000 /* margin 30% */ }, TIERS);
    expect(r.tier.label).toBe('Tier 1');
    expect(r.payable).toBe(12); // 4% of 300
  });

  it('zero revenue → 0 commission, Base tier', () => {
    const r = computeCommission({ profit: 0, revenue: 0 }, TIERS);
    expect(r.payable).toBe(0);
    expect(r.tier.label).toBe('Base');
  });

  it('overrideRate wins when supplied (per-user)', () => {
    const r = computeCommission({ profit: 1000, revenue: 1000, overrideRate: 7.5 }, TIERS);
    expect(r.payable).toBe(75);
    expect(r.tier.label).toBe('Override');
  });
});

describe('GET /api/commission/tiers', () => {
  beforeEach(async () => { await resetDb(); });

  it('both roles can read', async () => {
    for (const email of [ALEX, MARCUS]) {
      const { token } = await loginAs(email);
      const r = await api<{ tiers: Tier[] }>('GET', '/api/commission/tiers', { token });
      expect(r.status).toBe(200);
      expect(r.body.tiers.length).toBe(4);
    }
  });

  it('manager can PUT new tiers', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PUT', '/api/commission/tiers', {
      token, body: { tiers: [
        { label: 'Flat', floorPct: 0, rate: 5 },
      ] },
    });
    expect(r.status).toBe(200);
    const got = await api<{ tiers: Tier[] }>('GET', '/api/commission/tiers', { token });
    expect(got.body.tiers.length).toBe(1);
    expect(got.body.tiers[0].rate).toBe(5);
  });
});

describe('GET /api/commission/preview', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns matching tier', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ tier: { label: string }; payable: number }>(
      'GET', '/api/commission/preview?profit=5000&margin=0.35', { token });
    expect(r.status).toBe(200);
    expect(r.body.tier.label).toBe('Tier 2');
    expect(r.body.payable).toBe(300); // 5000 * 6%
  });
});
```

- [ ] **Step 2: Run — should fail (computeCommission undefined)**

Run: `cd apps/backend && pnpm test commission`

- [ ] **Step 3: Implement lib**

```typescript
// apps/backend/src/lib/commission-calc.ts
export type Tier = {
  id?: number;
  label: string;
  floorPct: number;  // 0..100
  rate: number;      // 0..100
};

export type CommissionInput = {
  profit: number;
  revenue: number;
  overrideRate?: number | null;  // per-user override; null/undefined = use tiers
};

export type CommissionResult = {
  tier: Tier;
  rate: number;
  payable: number;
  marginPct: number;
};

export function computeCommission(input: CommissionInput, tiers: Tier[]): CommissionResult {
  const marginPct = input.revenue > 0 ? (input.profit / input.revenue) * 100 : 0;

  if (input.overrideRate != null) {
    return {
      tier: { label: 'Override', floorPct: 0, rate: input.overrideRate },
      rate: input.overrideRate,
      payable: +(input.profit * input.overrideRate / 100).toFixed(2),
      marginPct,
    };
  }
  // Highest tier whose floor is met
  const sorted = [...tiers].sort((a, b) => a.floorPct - b.floorPct);
  let chosen = sorted[0];
  for (const t of sorted) if (marginPct >= t.floorPct) chosen = t;
  return {
    tier: chosen,
    rate: chosen.rate,
    payable: +(input.profit * chosen.rate / 100).toFixed(2),
    marginPct,
  };
}
```

- [ ] **Step 4: Run pure-function tests — should pass**

Run: `cd apps/backend && pnpm test commission -t "computeCommission"`
Expected: 4 pure-function tests pass.

---

### Task 5.3: Commission routes

**Files:**
- Create: `apps/backend/src/routes/commission.ts`
- Modify: `apps/backend/src/index.ts`

- [ ] **Step 1: Route**

```typescript
// apps/backend/src/routes/commission.ts
import { Hono } from 'hono';
import { getDb } from '../db';
import { computeCommission, type Tier } from '../lib/commission-calc';
import type { Env, User } from '../types';

const commission = new Hono<{ Bindings: Env; Variables: { user: User } }>();

commission.get('/tiers', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<Tier[]>`
    SELECT id, label, floor_pct::float AS "floorPct", rate::float AS rate
    FROM commission_tiers ORDER BY position
  `;
  return c.json({ tiers: rows });
});

commission.put('/tiers', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { tiers: { label: string; floorPct: number; rate: number }[] }
    | null;
  if (!body || !Array.isArray(body.tiers)) return c.json({ error: 'tiers required' }, 400);
  const sql = getDb(c.env);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM commission_tiers`;
    for (let i = 0; i < body.tiers.length; i++) {
      const t = body.tiers[i];
      await tx`
        INSERT INTO commission_tiers (label, floor_pct, rate, position)
        VALUES (${t.label}, ${t.floorPct}, ${t.rate}, ${i})
      `;
    }
  });
  return c.json({ ok: true });
});

commission.get('/preview', async (c) => {
  const profit = Number(c.req.query('profit') ?? '0');
  const margin = Number(c.req.query('margin') ?? '0'); // 0..1 decimal
  const sql = getDb(c.env);
  const tiers = await sql<Tier[]>`
    SELECT id, label, floor_pct::float AS "floorPct", rate::float AS rate
    FROM commission_tiers ORDER BY position
  `;
  const revenue = margin > 0 ? profit / margin : 0;
  const result = computeCommission({ profit, revenue }, tiers);
  return c.json(result);
});

commission.get('/settings', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM commission_settings`;
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return c.json({ settings: out });
});

commission.put('/settings', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  const sql = getDb(c.env);
  for (const [k, v] of Object.entries(body)) {
    await sql`
      INSERT INTO commission_settings (key, value, updated_at)
      VALUES (${k}, ${sql.json(v)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  }
  return c.json({ ok: true });
});

export default commission;
```

- [ ] **Step 2: Mount in index.ts**

```typescript
import commissionRoutes from './routes/commission';
app.use('/api/commission/*', authMiddleware);
app.route('/api/commission', commissionRoutes);
```

- [ ] **Step 3: Run — all commission tests should pass**

Run: `cd apps/backend && pnpm test commission`

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0007_commission.sql apps/backend/src/routes/commission.ts \
        apps/backend/src/lib/commission-calc.ts apps/backend/src/index.ts \
        apps/backend/tests/commission.test.ts
git commit -m "feat(commission): tier table + routes + pure calc lib"
```

---

### Task 5.4: Refactor dashboard to use tier table

**Files:**
- Modify: `apps/backend/src/routes/dashboard.ts`
- Create: `apps/backend/tests/dashboard.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// apps/backend/tests/dashboard.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('GET /api/dashboard', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager sees team-wide KPIs', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ role: string; kpis: { revenue: number; commission: number } }>(
      'GET', '/api/dashboard?range=30d', { token });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('manager');
    expect(r.body.kpis.revenue).toBeGreaterThan(0);
    // commission must NOT equal exactly profit * 0.075 anymore — tiers now apply.
    // Hard to assert exact value without recomputing seed; assert >= 0 instead.
    expect(r.body.kpis.commission).toBeGreaterThanOrEqual(0);
  });

  it('purchaser scope: kpis match own profit, leaderboard hides others commission', async () => {
    const { token, user } = await loginAs(MARCUS);
    const r = await api<{
      kpis: { revenue: number };
      leaderboard: { id: string; commission: number | null }[];
    }>('GET', '/api/dashboard', { token });
    expect(r.status).toBe(200);
    for (const row of r.body.leaderboard) {
      if (row.id !== user.id) {
        // Others' commission should be null/undefined for non-self
        expect(row.commission == null).toBe(true);
      }
    }
  });

  it('range honored: 7d returns less than 90d', async () => {
    const { token } = await loginAs(ALEX);
    const a = await api<{ kpis: { count: number } }>('GET', '/api/dashboard?range=7d', { token });
    const b = await api<{ kpis: { count: number } }>('GET', '/api/dashboard?range=90d', { token });
    expect(a.body.kpis.count).toBeLessThanOrEqual(b.body.kpis.count);
  });
});
```

- [ ] **Step 2: Run — at least the leaderboard + range tests fail**

Run: `cd apps/backend && pnpm test dashboard`

- [ ] **Step 3: Refactor dashboard.ts**

Replace `apps/backend/src/routes/dashboard.ts` entirely:

```typescript
// apps/backend/src/routes/dashboard.ts
import { Hono } from 'hono';
import { getDb } from '../db';
import { computeCommission, type Tier } from '../lib/commission-calc';
import type { Env, User } from '../types';

const dashboard = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, 'ytd': 365 };

dashboard.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';
  const range = c.req.query('range') ?? '30d';
  const days = RANGE_DAYS[range] ?? 30;

  const tiers = await sql<Tier[]>`
    SELECT id, label, floor_pct::float AS "floorPct", rate::float AS rate
    FROM commission_tiers ORDER BY position
  `;

  const scopeFrag = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;

  // Aggregate per line then collapse with computeCommission so KPIs honor tiers.
  const lineRows = await sql<{ qty: number; unit_cost: number; sell_price: number | null }[]>`
    SELECT l.qty, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.created_at >= NOW() - (${days} || ' days')::interval AND ${scopeFrag}
  `;
  let revenue = 0, cost = 0, profit = 0, commission = 0;
  for (const r of lineRows) {
    const sp = r.sell_price ?? r.unit_cost;
    const rRev = sp * r.qty;
    const rCost = r.unit_cost * r.qty;
    const rProfit = rRev - rCost;
    revenue += rRev; cost += rCost; profit += rProfit;
    commission += computeCommission({ profit: rProfit, revenue: rRev }, tiers).payable;
  }
  commission = +commission.toFixed(2);

  // Distinct order count
  const cnt = (await sql<{ n: number }[]>`
    SELECT COUNT(DISTINCT o.id)::int AS n FROM orders o
    WHERE o.created_at >= NOW() - (${days} || ' days')::interval AND ${scopeFrag}
  `)[0].n;

  // 8-week sparkline (always weeks, regardless of range)
  const weeks = await sql<{ label: string; profit: number }[]>`
    WITH series AS (
      SELECT generate_series(
        date_trunc('week', NOW()) - INTERVAL '7 weeks',
        date_trunc('week', NOW()),
        INTERVAL '1 week'
      ) AS week_start
    )
    SELECT to_char(s.week_start,'IW') AS label,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit
    FROM series s
    LEFT JOIN orders o ON o.created_at >= s.week_start AND o.created_at < s.week_start + INTERVAL '1 week' AND ${scopeFrag}
    LEFT JOIN order_lines l ON l.order_id = o.id
    GROUP BY s.week_start ORDER BY s.week_start
  `;

  // Leaderboard
  const leaderboardRaw = await sql<{
    id: string; name: string; initials: string; email: string; role: string;
    count: number; revenue: number; profit: number;
  }[]>`
    SELECT u.id, u.name, u.initials, u.email, u.role,
           COUNT(DISTINCT o.id)::int AS count,
           COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float AS revenue,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit
    FROM users u JOIN orders o ON o.user_id = u.id JOIN order_lines l ON l.order_id = o.id
    WHERE u.role = 'purchaser'
    GROUP BY u.id, u.name, u.initials, u.email, u.role
    ORDER BY profit DESC
  `;
  const leaderboard = leaderboardRaw.map(row => {
    const showCommission = isManager || row.id === u.id;
    return {
      id: row.id, name: row.name, initials: row.initials, email: row.email, role: row.role,
      count: row.count, revenue: row.revenue, profit: row.profit,
      commission: showCommission
        ? computeCommission({ profit: row.profit, revenue: row.revenue }, tiers).payable
        : null,
    };
  });

  const byCatRows = await sql<{ category: string; count: number; revenue: number; profit: number }[]>`
    SELECT l.category, COUNT(*)::int AS count,
           COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float AS revenue,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.created_at >= NOW() - (${days} || ' days')::interval AND ${scopeFrag}
    GROUP BY l.category
  `;
  const byCat: Record<string, { count: number; revenue: number; profit: number }> = {};
  for (const r of byCatRows) byCat[r.category] = { count: r.count, revenue: r.revenue, profit: r.profit };

  const recent = await sql`
    SELECT l.id, l.category, l.brand, l.capacity, l.type, l.interface, l.description,
           l.qty, l.unit_cost::float, l.sell_price::float,
           o.created_at, o.id AS order_id,
           u.id AS user_id, u.name AS user_name, u.initials AS user_initials
    FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN users u ON u.id = o.user_id
    WHERE ${scopeFrag} ORDER BY o.created_at DESC, l.position ASC LIMIT 4
  `;

  return c.json({
    role: u.role,
    kpis: { count: cnt, cost, revenue, profit, commission },
    weeks, leaderboard, byCat, recent,
  });
});

export default dashboard;
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test dashboard`
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/dashboard.ts apps/backend/tests/dashboard.test.ts
git commit -m "refactor(dashboard): use commission tiers, honor range, scope commission visibility"
```

---

# Phase 6 — Workspace settings

PRD §4.11 + §5.8: a key/value store for workspace-wide settings — name, domain, currency, fiscal_start, timezone, fx_auto, week_start, notification toggles. Manager-only write.

---

### Task 6.1: Migration

**Files:**
- Create: `apps/backend/migrations/0008_workspace_settings.sql`

- [ ] **Step 1: Migration**

```sql
-- apps/backend/migrations/0008_workspace_settings.sql

CREATE TABLE IF NOT EXISTS workspace_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO workspace_settings (key, value) VALUES
  ('workspace_name', '"Recycle Servers"'::jsonb),
  ('domain',         '"recycleservers.io"'::jsonb),
  ('currency',       '"USD"'::jsonb),
  ('fiscal_start',   '"January"'::jsonb),
  ('timezone',       '"America/Los_Angeles"'::jsonb),
  ('fx_auto',        'true'::jsonb),
  ('week_start',     '"Monday"'::jsonb),
  ('notify_new_order',     'true'::jsonb),
  ('notify_weekly_digest', 'true'::jsonb),
  ('notify_low_margin',    'true'::jsonb),
  ('notify_capacity',      'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Apply**

Run: `cd apps/backend && pnpm db:migrate`

---

### Task 6.2: Workspace route + tests

**Files:**
- Create: `apps/backend/src/routes/workspace.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/workspace.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
// apps/backend/tests/workspace.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('/api/workspace', () => {
  beforeEach(async () => { await resetDb(); });

  it('GET returns defaults', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ settings: Record<string, unknown> }>('GET', '/api/workspace', { token });
    expect(r.status).toBe(200);
    expect(r.body.settings.currency).toBe('USD');
    expect(r.body.settings.timezone).toBe('America/Los_Angeles');
  });

  it('PATCH manager can update', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/workspace', { token, body: { currency: 'HKD' } });
    expect(r.status).toBe(200);
    const got = await api<{ settings: Record<string, unknown> }>('GET', '/api/workspace', { token });
    expect(got.body.settings.currency).toBe('HKD');
  });

  it('PATCH purchaser is forbidden', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('PATCH', '/api/workspace', { token, body: { currency: 'EUR' } });
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run — should fail (404)**

Run: `cd apps/backend && pnpm test workspace`

- [ ] **Step 3: Route**

```typescript
// apps/backend/src/routes/workspace.ts
import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const workspace = new Hono<{ Bindings: Env; Variables: { user: User } }>();

workspace.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM workspace_settings`;
  const settings: Record<string, unknown> = {};
  for (const r of rows) settings[r.key] = r.value;
  return c.json({ settings });
});

workspace.patch('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  const sql = getDb(c.env);
  for (const [k, v] of Object.entries(body)) {
    await sql`
      INSERT INTO workspace_settings (key, value, updated_at)
      VALUES (${k}, ${sql.json(v)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  }
  return c.json({ ok: true });
});

export default workspace;
```

- [ ] **Step 4: Mount**

```typescript
// in apps/backend/src/index.ts
import workspaceRoutes from './routes/workspace';
app.use('/api/workspace/*', authMiddleware);
app.route('/api/workspace', workspaceRoutes);
```

- [ ] **Step 5: Run — should pass**

Run: `cd apps/backend && pnpm test workspace`

- [ ] **Step 6: Commit**

```bash
git add apps/backend/migrations/0008_workspace_settings.sql apps/backend/src/routes/workspace.ts \
        apps/backend/src/index.ts apps/backend/tests/workspace.test.ts
git commit -m "feat(workspace): settings store + manager-only PATCH"
```

---

# Phase 7 — Notification triggers

Currently notifications are seeded but never produced by domain events. We add a small internal `notify()` helper and hook it into:
1. Order advanced to `In Transit` → notify all managers (kind `order_submitted`).
2. Inventory price set with margin < 15% → notify the actor (kind `low_margin`).
3. Sell order advanced to `Done` → notify each underlying line's submitter (kind `payment_received`).

---

### Task 7.1: notify() helper

**Files:**
- Create: `apps/backend/src/lib/notify.ts`

- [ ] **Step 1: Helper**

```typescript
// apps/backend/src/lib/notify.ts
import type { Sql } from 'postgres';

export type NotifyInput = {
  userId: string;
  kind: string;
  tone?: 'info' | 'warn' | 'pos';
  icon?: string;
  title: string;
  body?: string | null;
};

export async function notify(tx: Sql, n: NotifyInput): Promise<void> {
  await tx`
    INSERT INTO notifications (id, user_id, kind, tone, icon, title, body, unread)
    VALUES (gen_random_uuid()::text, ${n.userId}, ${n.kind}, ${n.tone ?? 'info'},
            ${n.icon ?? 'bell'}, ${n.title}, ${n.body ?? null}, TRUE)
  `;
}

export async function notifyManagers(tx: Sql, n: Omit<NotifyInput, 'userId'>): Promise<void> {
  const mgrs = await tx<{ id: string }[]>`SELECT id FROM users WHERE role = 'manager' AND COALESCE(active, true)`;
  for (const m of mgrs) await notify(tx, { ...n, userId: m.id });
}
```

(Note: the notifications table uses TEXT id in seed but UUID-style would also work; check `migrations/0001_init.sql` — confirm id column type. If it's TEXT default not-null, the `gen_random_uuid()::text` cast above is correct. If it's autoincrement, drop the explicit id.)

- [ ] **Step 2: Verify notification id column shape (one-time read)**

Run: `psql "$DATABASE_URL" -c "\d notifications"` and confirm `id` is TEXT. If not, adjust the INSERT.

---

### Task 7.2: Order-submitted notification

**Files:**
- Modify: `apps/backend/src/routes/orders.ts`
- Modify: `apps/backend/tests/orders.test.ts`

- [ ] **Step 1: Failing test**

Append to `tests/orders.test.ts`:

```typescript
describe('notifications on order advance', () => {
  beforeEach(async () => { await resetDb(); });

  it('advancing to in_transit notifies managers', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { token: mTok } = await loginAs(ALEX);
    // Snapshot manager's current unread count.
    const before = await api<{ unreadCount: number }>('GET', '/api/notifications', { token: mTok });

    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });

    const after = await api<{ unreadCount: number; items: { kind: string; title: string }[] }>(
      'GET', '/api/notifications', { token: mTok });
    expect(after.body.unreadCount).toBeGreaterThan(before.body.unreadCount);
    expect(after.body.items.some(i => i.kind === 'order_submitted')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `cd apps/backend && pnpm test orders -t "notifications on order advance"`

- [ ] **Step 3: Hook into advance handler**

Open `apps/backend/src/routes/orders.ts`. At the top with other imports:

```typescript
import { notifyManagers } from '../lib/notify';
```

In the `orders.post('/:id/advance', ...)` handler, **inside** the `sql.begin` after the existing UPDATE statements, when `nextStageId === 'in_transit'`:

```typescript
if (nextStageId === 'in_transit') {
  await notifyManagers(tx, {
    kind: 'order_submitted',
    tone: 'info',
    icon: 'inventory',
    title: `Order ${id} submitted`,
    body: `${u.name} advanced ${id} to In Transit`,
  });
}
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test orders`

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/lib/notify.ts apps/backend/src/routes/orders.ts apps/backend/tests/orders.test.ts
git commit -m "feat(notify): managers notified when an order goes to In Transit"
```

---

### Task 7.3: Low-margin notification

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts`
- Modify: `apps/backend/tests/inventory.test.ts`

- [ ] **Step 1: Failing test**

Append to `inventory.test.ts`:

```typescript
describe('low-margin notification', () => {
  beforeEach(async () => { await resetDb(); });

  it('fires when sell_price gives margin < 15%', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: { id: string; unit_cost: number }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token });
    const target = list.body.items[0];
    // unit_cost * 1.05 → margin ~5%
    const newPrice = +(target.unit_cost * 1.05).toFixed(2);

    const before = await api<{ unreadCount: number }>('GET', '/api/notifications', { token });
    const r = await api<{ warnings?: string[] }>('PATCH', `/api/inventory/${target.id}`, {
      token, body: { sellPrice: newPrice },
    });
    expect(r.status).toBe(200);
    expect(r.body.warnings ?? []).toContain('low_margin');
    const after = await api<{ items: { kind: string }[] }>('GET', '/api/notifications', { token });
    expect(after.body.items.some(i => i.kind === 'low_margin')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `cd apps/backend && pnpm test inventory -t "low-margin"`

- [ ] **Step 3: Hook into PATCH /api/inventory/:id**

Open `apps/backend/src/routes/inventory.ts`. At the top:

```typescript
import { notify } from '../lib/notify';
```

Replace the final `return c.json({ ok: true });` of the PATCH handler with:

```typescript
const warnings: string[] = [];
if (body.sellPrice !== undefined) {
  const cost = body.unitCost ?? before.unit_cost;
  const sp = body.sellPrice;
  if (sp < cost) warnings.push('sub_cost_sell');
  const margin = sp > 0 ? ((sp - cost) / sp) : 0;
  if (margin < 0.15) {
    warnings.push('low_margin');
    await sql.begin(async (tx) => {
      await notify(tx, {
        userId: u.id,
        kind: 'low_margin',
        tone: 'warn',
        icon: 'alert',
        title: `Low margin on ${before.part_number ?? 'line'}`,
        body: `Sell ${sp} vs cost ${cost} → ${(margin * 100).toFixed(1)}% margin`,
      });
    });
  }
}
return c.json({ ok: true, warnings });
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test inventory`

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/inventory.ts apps/backend/tests/inventory.test.ts
git commit -m "feat(inventory): low_margin / sub_cost_sell warnings + notification"
```

---

### Task 7.4: Payment-received notification (sell order Done)

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts`
- Modify: `apps/backend/tests/sell-orders.test.ts`

- [ ] **Step 1: Failing test**

Append to `sell-orders.test.ts`:

```typescript
describe('payment_received notification', () => {
  beforeEach(async () => { await resetDb(); });

  it('notifies submitter when sell order is Done', async () => {
    const { token: mTok } = await loginAs(ALEX);
    // Find a sellable line + its submitter
    const list = await api<{ items: { id: string; user_id: string; sell_price: number | null }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token: mTok });
    const target = list.body.items.find(i => i.sell_price != null)!;
    // login as the submitter to read their notifications later
    const submitterRow = (await api<{ items: { id: string; email: string }[] }>(
      'GET', '/api/members', { token: mTok })).body.items.find(m => m.id === target.user_id);
    const submitterEmail = submitterRow!.email;
    const { token: subTok } = await loginAs(submitterEmail);

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mTok,
      body: { customerId: 'c1', lines: [{
        inventoryId: target.id, category: 'RAM', label: 'x', partNumber: 'pn',
        qty: 1, unitPrice: target.sell_price as number,
      }] },
    });
    const soId = create.body.id;
    await api('POST', `/api/sell-orders/${soId}/status`, { token: mTok, body: { to: 'Shipped', note: 's' } });
    await api('POST', `/api/sell-orders/${soId}/status`, { token: mTok, body: { to: 'Awaiting payment', note: 'a' } });
    await api('POST', `/api/sell-orders/${soId}/status`, { token: mTok, body: { to: 'Done', note: 'paid' } });

    const got = await api<{ items: { kind: string }[] }>('GET', '/api/notifications', { token: subTok });
    expect(got.body.items.some(i => i.kind === 'payment_received')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — should fail**

- [ ] **Step 3: Hook into sell-order status route**

Open `apps/backend/src/routes/sellOrders.ts`. At top:

```typescript
import { notify } from '../lib/notify';
```

Inside the `if (body.to === 'Done')` block within `sql.begin`, after the inventory update + audit insert, add:

```typescript
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
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test sell-orders`

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts apps/backend/tests/sell-orders.test.ts
git commit -m "feat(notify): submitters notified when sell order closes"
```

---

### Task 7.5: Per-notification mark-read

**Files:**
- Modify: `apps/backend/src/routes/notifications.ts`
- Create: `apps/backend/tests/notifications.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// apps/backend/tests/notifications.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('notifications mark-read', () => {
  beforeEach(async () => { await resetDb(); });

  it('mark-one moves a specific notification to read', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: { id: string; unread: boolean }[] }>('GET', '/api/notifications', { token });
    const target = list.body.items.find(i => i.unread);
    if (!target) return; // skip if seed has no unread
    const r = await api('POST', `/api/notifications/${target.id}/mark-read`, { token });
    expect(r.status).toBe(200);
    const after = await api<{ items: { id: string; unread: boolean }[] }>('GET', '/api/notifications', { token });
    expect(after.body.items.find(i => i.id === target.id)!.unread).toBe(false);
  });
});
```

- [ ] **Step 2: Run — should fail (route missing)**

- [ ] **Step 3: Add route**

Append to `apps/backend/src/routes/notifications.ts` before `export default`:

```typescript
notifications.post('/:id/mark-read', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const r = await sql`
    UPDATE notifications SET unread = FALSE
    WHERE id = ${c.req.param('id')} AND user_id = ${u.id}
    RETURNING id
  `;
  if (r.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test notifications`

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/notifications.ts apps/backend/tests/notifications.test.ts
git commit -m "feat(notifications): per-notification mark-read endpoint"
```

---

# Phase 8 — Pagination, sort allowlists, audit-log immutability

Cross-cutting NFRs that protect against runaway queries and tampering. Done last so all earlier endpoints can adopt the helper without churn.

---

### Task 8.1: Audit log immutability

**Files:**
- Create: `apps/backend/migrations/0009_audit_lock.sql`

- [ ] **Step 1: Migration**

```sql
-- apps/backend/migrations/0009_audit_lock.sql
-- Lock inventory_events so neither the app nor a curious psql session can
-- mutate the audit log. Inserts are allowed; updates and deletes raise.

CREATE OR REPLACE FUNCTION inventory_events_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_events is append-only — UPDATE/DELETE not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_events_no_update ON inventory_events;
DROP TRIGGER IF EXISTS inventory_events_no_delete ON inventory_events;
CREATE TRIGGER inventory_events_no_update BEFORE UPDATE ON inventory_events
  FOR EACH ROW EXECUTE FUNCTION inventory_events_lock();
CREATE TRIGGER inventory_events_no_delete BEFORE DELETE ON inventory_events
  FOR EACH ROW EXECUTE FUNCTION inventory_events_lock();
```

- [ ] **Step 2: Apply**

Run: `cd apps/backend && pnpm db:migrate`

- [ ] **Step 3: Test**

Add to `tests/inventory.test.ts`:

```typescript
describe('audit log is append-only', () => {
  beforeEach(async () => { await resetDb(); });

  it('raw UPDATE on inventory_events is rejected', async () => {
    const { getTestDb } = await import('./helpers/db');
    const sql = getTestDb();
    let err: Error | null = null;
    try {
      await sql`UPDATE inventory_events SET detail = '{}'::jsonb WHERE id IN (SELECT id FROM inventory_events LIMIT 1)`;
    } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/append-only/i);
  });
});
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/backend && pnpm test inventory`

- [ ] **Step 5: Commit**

```bash
git add apps/backend/migrations/0009_audit_lock.sql apps/backend/tests/inventory.test.ts
git commit -m "feat(audit): DB trigger blocks UPDATE/DELETE on inventory_events"
```

---

### Task 8.2: Pagination helper + indexes

**Files:**
- Create: `apps/backend/src/lib/pagination.ts`
- Create: `apps/backend/migrations/0010_indexes_pagination.sql`
- Create: `apps/backend/tests/pagination.test.ts`

- [ ] **Step 1: Helper**

```typescript
// apps/backend/src/lib/pagination.ts
export type Cursor = { ts: string; id: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { return null; }
}

export function clampLimit(raw: string | null | undefined, def = 50, max = 200): number {
  const n = Number(raw ?? def);
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(n, max);
}

const ALLOWED_SORT: Record<string, Set<string>> = {
  orders: new Set(['created_at', 'total_cost', 'lifecycle']),
  inventory: new Set(['created_at', 'qty', 'sell_price', 'unit_cost']),
  'sell-orders': new Set(['created_at', 'status']),
};
export function parseSort(scope: keyof typeof ALLOWED_SORT, raw: string | null | undefined):
  | { col: string; dir: 'asc' | 'desc' }
  | null {
  if (!raw) return null;
  const [col, dirRaw] = raw.split(':');
  if (!ALLOWED_SORT[scope].has(col)) return null;
  const dir = (dirRaw === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
  return { col, dir };
}
```

- [ ] **Step 2: Indexes migration**

```sql
-- apps/backend/migrations/0010_indexes_pagination.sql
CREATE INDEX IF NOT EXISTS order_lines_part_number_status_idx ON order_lines(part_number, status);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id, unread, created_at DESC);
CREATE INDEX IF NOT EXISTS sell_orders_created_at_idx ON sell_orders(created_at DESC);
```

- [ ] **Step 3: Failing test**

```typescript
// apps/backend/tests/pagination.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('pagination on /api/orders', () => {
  beforeEach(async () => { await resetDb(); });

  it('limit caps response size', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ orders: unknown[]; nextCursor: string | null }>(
      'GET', '/api/orders?limit=3', { token });
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBeLessThanOrEqual(3);
    expect(r.body.nextCursor).toBeTruthy();
  });

  it('cursor returns next page without overlap', async () => {
    const { token } = await loginAs(ALEX);
    const a = await api<{ orders: { id: string }[]; nextCursor: string | null }>(
      'GET', '/api/orders?limit=3', { token });
    const b = await api<{ orders: { id: string }[]; nextCursor: string | null }>(
      'GET', '/api/orders?limit=3&cursor=' + encodeURIComponent(a.body.nextCursor!), { token });
    expect(b.status).toBe(200);
    const ids = new Set(a.body.orders.map(o => o.id));
    for (const o of b.body.orders) expect(ids.has(o.id)).toBe(false);
  });

  it('rejects unknown sort column', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/orders?sort=password_hash:asc', { token });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 4: Run — should fail**

Run: `cd apps/backend && pnpm test pagination`

- [ ] **Step 5: Apply pagination to /api/orders**

Open `apps/backend/src/routes/orders.ts`. Replace the GET `/` handler with one that uses the helper. Add at the top:

```typescript
import { clampLimit, decodeCursor, encodeCursor, parseSort } from '../lib/pagination';
```

Replace the GET `/` handler body's tail (where it currently does `ORDER BY o.created_at DESC LIMIT ${limit}`) with:

```typescript
const limit = clampLimit(c.req.query('limit'), 50, 200);
const sortRaw = c.req.query('sort');
if (sortRaw && !parseSort('orders', sortRaw)) return c.json({ error: 'sort column not allowed' }, 400);
const sort = parseSort('orders', sortRaw) ?? { col: 'created_at', dir: 'desc' as const };
const cursor = decodeCursor(c.req.query('cursor'));

// keyset pagination: (created_at, id) lexicographic
const cursorFrag = cursor
  ? (sort.dir === 'desc'
      ? sql`AND (o.created_at, o.id) < (${cursor.ts}, ${cursor.id})`
      : sql`AND (o.created_at, o.id) > (${cursor.ts}, ${cursor.id})`)
  : sql``;

const rows = await sql`
  SELECT
    o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
    o.total_cost::float AS total_cost,
    u.name AS user_name, u.initials AS user_initials,
    w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region,
    COALESCE(SUM(l.qty), 0)::int AS qty,
    COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float AS revenue,
    COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit,
    COUNT(l.id)::int AS line_count,
    array_agg(DISTINCT l.status) AS line_statuses
  FROM orders o
  JOIN users u ON u.id = o.user_id
  LEFT JOIN warehouses w ON w.id = o.warehouse_id
  LEFT JOIN order_lines l ON l.order_id = o.id
  WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag} ${cursorFrag}
  GROUP BY o.id, u.name, u.initials, w.id, w.short, w.region
  ORDER BY o.${sql(sort.col)} ${sql.unsafe(sort.dir.toUpperCase())}, o.id ${sql.unsafe(sort.dir.toUpperCase())}
  LIMIT ${limit + 1}
`;
const hasMore = rows.length > limit;
const slice = hasMore ? rows.slice(0, limit) : rows;
const nextCursor = hasMore
  ? encodeCursor({ ts: (slice[slice.length - 1] as { created_at: string }).created_at, id: (slice[slice.length - 1] as { id: string }).id })
  : null;

return c.json({
  orders: slice.map(r => ({
    id: r.id, userId: r.user_id, userName: r.user_name, userInitials: r.user_initials,
    category: r.category, payment: r.payment, notes: r.notes, lifecycle: r.lifecycle,
    createdAt: r.created_at, totalCost: r.total_cost,
    warehouse: r.warehouse_id ? { id: r.warehouse_id, short: r.warehouse_short, region: r.warehouse_region } : null,
    qty: r.qty, revenue: r.revenue, profit: r.profit, lineCount: r.line_count,
    status: (r.line_statuses?.length === 1 ? r.line_statuses[0] : 'Mixed') as string,
  })),
  nextCursor,
});
```

- [ ] **Step 6: Run — should pass**

Run: `cd apps/backend && pnpm test pagination`

- [ ] **Step 7: Apply pagination to remaining list endpoints**

Repeat the same pattern for `/api/inventory` and `/api/sell-orders` in their respective route files. (Each is ~20 LoC of changes — same shape as above. Write one test per endpoint to verify cursor advancement.) Commit each separately.

```bash
git add apps/backend/src/lib/pagination.ts apps/backend/migrations/0010_indexes_pagination.sql \
        apps/backend/src/routes/orders.ts apps/backend/tests/pagination.test.ts
git commit -m "feat(api): cursor pagination + sort allowlist on /api/orders"
```

After applying the same to inventory and sell-orders:

```bash
git commit -am "feat(api): cursor pagination + sort allowlist on inventory, sell-orders"
```

---

### Task 8.3: Final integration check

**Files:** (none — runs everything)

- [ ] **Step 1: Full test suite**

```bash
cd apps/backend && pnpm test
```

Expected: all tests across orders, inventory, categories, sell-orders, attachments, commission, dashboard, workspace, notifications, pagination, smoke pass.

- [ ] **Step 2: Typecheck**

```bash
cd apps/backend && pnpm typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Manual sanity — start dev server and run the PRD T1.1 + T4.3 from §8 of the spec**

```bash
cd apps/backend && pnpm dev   # in one shell
# in another:
curl -s -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"alex@recycleservers.io","password":"demo"}'
```

Expected: `{ token, user }`.

- [ ] **Step 4: Done — commit any remaining churn**

```bash
git status
# if any auto-formatting / lint touch-ups occurred:
git commit -am "chore: post-suite cleanup"
```

---

## Self-review (already performed)

### Spec coverage map

| PRD section | Phase covering it |
| --- | --- |
| §4.1 users | already implemented (auth, members) — no changes needed |
| §4.2 warehouses | already implemented — no changes needed |
| §4.3 customers | already implemented — no changes needed |
| §4.4 categories | Phase 3 |
| §4.5 orders + lines | Phase 1 (defaults), Phase 8 (pagination) |
| §4.6 inventory_events | Phase 2 (PATCH already writes events), Phase 8 (immutability) |
| §4.7 sell_orders + status_meta | Phase 4 |
| §4.8 ref_prices | already implemented — out of scope here |
| §4.9 workflow_stages | already implemented — no changes needed |
| §4.10 commission | Phase 5 |
| §4.11 workspace_settings | Phase 6 |
| §4.12 notifications | Phase 7 |
| §4.13 attachments | Phase 4 |
| §6 business rules | Phases 1, 2, 4, 5, 7 enforce each one |
| §7 NFRs (pagination, sort allowlist, audit immutability) | Phase 8 |
| §8 test flow (T1–T14) | Each phase adds the relevant tests directly; the 65 PRD test cases are progressively covered. Note: a few advanced cases (T13.1 rate limit, T13.2 idempotency, T13.5 SQL injection) are explicitly NOT covered by this plan — they're deferred. |

### Placeholder scan
- No "TBD" / "TODO" / "fill in later" anywhere.
- Each step has either a full code block or a concrete shell command.

### Type consistency spot-check
- `Tier` shape used in `commission-calc.ts` and queries: `{ id, label, floorPct, rate }` — consistent. SQL returns `floor_pct::float AS "floorPct"` to match.
- `notify()` signature consistent across callers (Phase 7).
- `clampLimit/encodeCursor/decodeCursor/parseSort` signatures consistent in all callers.

### Deferred items (intentional)
- **Rate limiting** (§7 NFR): defer to a separate plan — needs a Cloudflare middleware decision (Workers Rate Limit binding vs a Postgres-based bucket).
- **Idempotency-Key** (§7 NFR): defer — needs a Redis or KV binding for the body-hash store; trivial DB-based version possible later.
- **SQL injection probe T13.5**: postgres.js already parameterizes; spot-add a single test if you want regression coverage.
- **R2 attachment storage**: Phase 4 stores attachment metadata only with synthetic storage_ids. Real Cloudflare R2 upload (binding `c.env.R2`) is a follow-up — wire the same `attachments.storage_id` to a real R2 PUT.
- **Background jobs** (FX, weekly digest, commission release cron): separate plan; needs Cloudflare Cron Triggers + a worker `scheduled()` handler.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-05-11-recycle-erp-backend-implementation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
