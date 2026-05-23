# Market Manual Price + Last-Price Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading "avg sell" headline on the Market page with a most-recent-price metric + 5-day staleness signal, and add a manager-only inline pencil that records ad-hoc manual price updates with a per-entry audit trail.

**Architecture:** Add denormalised `last_price` / `last_price_at` / `last_price_source` columns on `ref_prices`, plus a `ref_price_events` audit table that every write path (manual endpoint, scraper batch, seed) funnels through via a single `appendPriceEvent` helper. The desktop Market page reads `lastPrice` + `recentPrices` (last 12 events) from the existing `GET /api/market` and shows a hover-pencil popover gated by `user.role === 'manager'`.

**Tech Stack:** Postgres 16 (DDL + denormalised columns + per-entity audit table), Hono on Node 22, postgres.js (`sql.begin` transactions, parameterised queries), React 18 + plain CSS (no extra UI lib), Vitest integration tests against real Postgres.

**Spec:** [docs/superpowers/specs/2026-05-23-market-manual-price-design.md](../specs/2026-05-23-market-manual-price-design.md)

---

## Pre-flight conventions (read once before starting)

- **User commits directly to `main`. Do not create feature branches.** Each task ends with a commit.
- Backend tests are integration tests against `127.0.0.1:5432`. The Postgres container must be running: `docker compose up -d postgres`. The host-side `docker-compose.override.yml` publishes the port.
- Run a single backend test file: `pnpm --filter recycle-erp-backend test -- <substring>`.
- Run all backend tests: `pnpm --filter recycle-erp-backend test`.
- Run a single frontend test: `pnpm --filter recycle-erp-frontend test -- <substring>`.
- Migrations run automatically on backend startup and at the top of the test bootstrap (`tests/helpers/db.ts → resetDb()`). After adding a new migration file under `apps/backend/migrations/`, the next test run picks it up — no manual step needed.
- All mutating routes are wrapped in `csrfGuard`. The `api()` helper in `tests/helpers/app.ts` sets `X-Requested-By: recycle-erp` automatically. Use it; do not call `app.fetch` directly.
- Test users (from `tests/helpers/auth.ts`): `ALEX` (manager), `MARCUS` (purchaser), `PRIYA` (purchaser). `loginAs(ALEX)` returns `{ token, user, cookies }` where `token` is the `at` cookie value.
- `app.use('/api/market/*', authMiddleware)` is mounted but `POST /api/market/values` is exempt (scraper bearer-only). The new `POST /api/market/:id/manual-price` lives inside the cookie-auth subtree.
- Comments: terse, `Why` only, no `What`. No issue/PR references. Match existing route-file tone.
- Do **not** create a CHANGELOG entry, README change, or any *.md file other than tasks explicitly listed below.

---

## Task 1: Migration — `ref_prices` last-price columns + `ref_price_events` table

**Files:**
- Create: `apps/backend/migrations/0052_ref_prices_manual_overrides.sql`

- [ ] **Step 1: Write the migration**

Create `apps/backend/migrations/0052_ref_prices_manual_overrides.sql`:

```sql
-- Denormalised "last recorded price" for the Market Value surface.
-- The page used to read avg_sell as the headline metric, but with few
-- samples per SKU an average is a poor reference; last_price is the
-- price someone actually saw most recently, and last_price_at drives a
-- 5-day staleness signal in the UI.
--
-- Both columns are populated by the appendPriceEvent helper, which is
-- the single write path for manual entries, scraper batches, and seed.
-- avg_sell stays in place (MCP + legacy callers still read it).

ALTER TABLE ref_prices
  ADD COLUMN IF NOT EXISTS last_price        NUMERIC,
  ADD COLUMN IF NOT EXISTS last_price_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_price_source TEXT;

CREATE INDEX IF NOT EXISTS ref_prices_last_price_at_idx
  ON ref_prices (last_price_at DESC);

-- Per-entry audit trail. Parallel to sell_order_events / order_events:
-- append-only, indexed for the "last 12 events" sparkline read path.
-- actor_user_id NULLs out on user delete so the event survives — the
-- price/source/timestamp are the load-bearing fields.

CREATE TABLE IF NOT EXISTS ref_price_events (
  id            BIGSERIAL PRIMARY KEY,
  ref_price_id  UUID NOT NULL REFERENCES ref_prices(id) ON DELETE CASCADE,
  price         NUMERIC NOT NULL CHECK (price >= 0),
  source        TEXT    NOT NULL,
  note          TEXT,
  actor_user_id UUID    REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ref_price_events_ref_price_id_idx
  ON ref_price_events (ref_price_id, created_at DESC);
```

- [ ] **Step 2: Apply the migration**

Run: `pnpm --filter recycle-erp-backend exec node scripts/migrate.mjs`

Expected output ends with a line like `applied 0052_ref_prices_manual_overrides.sql`.

- [ ] **Step 3: Verify the schema**

Run: `docker exec recycle_pg psql -U recycle -d recycle_erp -c "\d ref_prices" | grep -E "last_price|last_price_at|last_price_source"`

Expected: three rows showing the new columns with their types (`numeric`, `timestamp with time zone`, `text`).

Run: `docker exec recycle_pg psql -U recycle -d recycle_erp -c "\d ref_price_events"`

Expected: table description showing all six columns, the primary key, and the `ref_price_events_ref_price_id_idx` index.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0052_ref_prices_manual_overrides.sql
git commit -m "feat(db): add last_price columns and ref_price_events audit table"
```

---

## Task 2: `appendPriceEvent` helper — write the failing test

**Files:**
- Create: `apps/backend/tests/ref-price-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/ref-price-events.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { appendPriceEvent } from '../src/lib/refPriceEvents';

describe('appendPriceEvent', () => {
  let refPriceId: string;
  let userId: string;
  beforeAll(async () => {
    await resetDb();
    const sql = getTestDb();
    refPriceId = (await sql<{ id: string }[]>`SELECT id FROM ref_prices LIMIT 1`)[0].id;
    userId = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
  });

  it('inserts an event and updates ref_prices.last_price* atomically', async () => {
    const sql = getTestDb();
    const ev = await sql.begin(async (tx) =>
      appendPriceEvent(tx, {
        refPriceId,
        price: 42.5,
        source: 'manual:test@x.io',
        note: 'broker quote',
        actorUserId: userId,
      }),
    );
    expect(ev.price).toBe(42.5);
    expect(ev.source).toBe('manual:test@x.io');

    const rp = (await sql<{ last_price: number; last_price_source: string; last_price_at: Date }[]>`
      SELECT last_price::float AS last_price, last_price_source, last_price_at
      FROM ref_prices WHERE id = ${refPriceId}
    `)[0];
    expect(rp.last_price).toBe(42.5);
    expect(rp.last_price_source).toBe('manual:test@x.io');
    expect(rp.last_price_at).toBeInstanceOf(Date);

    const evRow = (await sql<{ price: number; note: string | null; actor_user_id: string | null }[]>`
      SELECT price::float AS price, note, actor_user_id
      FROM ref_price_events
      WHERE ref_price_id = ${refPriceId}
      ORDER BY created_at DESC LIMIT 1
    `)[0];
    expect(evRow.price).toBe(42.5);
    expect(evRow.note).toBe('broker quote');
    expect(evRow.actor_user_id).toBe(userId);
  });

  it('a second call appends another event and bumps last_price', async () => {
    const sql = getTestDb();
    await sql.begin(async (tx) =>
      appendPriceEvent(tx, {
        refPriceId,
        price: 99.99,
        source: 'scraper:test',
        note: null,
        actorUserId: null,
      }),
    );
    const rp = (await sql<{ last_price: number; last_price_source: string }[]>`
      SELECT last_price::float AS last_price, last_price_source
      FROM ref_prices WHERE id = ${refPriceId}
    `)[0];
    expect(rp.last_price).toBe(99.99);
    expect(rp.last_price_source).toBe('scraper:test');

    const count = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter recycle-erp-backend test -- ref-price-events`

Expected: FAIL — module `../src/lib/refPriceEvents` not found.

---

## Task 3: Implement `appendPriceEvent`

**Files:**
- Create: `apps/backend/src/lib/refPriceEvents.ts`

- [ ] **Step 1: Implement the helper**

Create `apps/backend/src/lib/refPriceEvents.ts`:

```ts
import type postgres from 'postgres';

// Single write path for any change to ref_prices.last_price. Inserts the
// event then updates the denormalised columns on ref_prices inside the
// caller's sql.begin so both rows commit or neither does.

export type AppendPriceEventArgs = {
  refPriceId: string;
  price: number;
  source: string;
  note: string | null;
  actorUserId: string | null;
};

export type AppendedPriceEvent = {
  id: string;
  price: number;
  source: string;
  note: string | null;
  createdAt: Date;
};

export async function appendPriceEvent(
  tx: postgres.TransactionSql,
  args: AppendPriceEventArgs,
): Promise<AppendedPriceEvent> {
  const ev = (await tx<{ id: string; price: number; source: string; note: string | null; created_at: Date }[]>`
    INSERT INTO ref_price_events (ref_price_id, price, source, note, actor_user_id)
    VALUES (${args.refPriceId}, ${args.price}, ${args.source}, ${args.note}, ${args.actorUserId})
    RETURNING id::text AS id, price::float AS price, source, note, created_at
  `)[0];

  await tx`
    UPDATE ref_prices
       SET last_price        = ${args.price},
           last_price_at     = ${ev.created_at},
           last_price_source = ${args.source},
           updated_at        = NOW()
     WHERE id = ${args.refPriceId}
  `;

  return {
    id: ev.id,
    price: ev.price,
    source: ev.source,
    note: ev.note,
    createdAt: ev.created_at,
  };
}
```

- [ ] **Step 2: Run the test, confirm it passes**

Run: `pnpm --filter recycle-erp-backend test -- ref-price-events`

Expected: PASS — both `it()` blocks green.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/lib/refPriceEvents.ts apps/backend/tests/ref-price-events.test.ts
git commit -m "feat(be): appendPriceEvent helper + integration tests"
```

---

## Task 4: Refactor `applyMarketWrites` to also append events

**Files:**
- Modify: `apps/backend/src/lib/marketWrite.ts`
- Modify: `apps/backend/tests/market-write.test.ts`

The existing route stays the same — only the helper and its tests change. `history` JSONB writes are dropped; `applyMarketWrites` now calls `appendPriceEvent` for each accepted row.

- [ ] **Step 1: Update the test for the new audit-row behaviour**

Replace the body of the `'updates an existing row, appends history, recomputes trend'` test in `apps/backend/tests/market-write.test.ts` (lines around the existing assertion that `after.history.length` grew). Use:

```ts
  it('updates an existing row, appends an event, recomputes trend', async () => {
    const sql = getTestDb();
    const beforeEvents = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${knownId}
    `)[0].c;
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: {
        values: [{
          selector: { id: knownId },
          low: '100.00', high: '160.00', avgSell: '130.00',
          samples: 9, source: 'test-scraper',
        }],
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.updated).toBe(1);
    expect(body.notFound).toBe(0);
    expect(body.errors).toEqual([]);

    const after = (await sql<{ avg_sell: number; samples: number; trend: number | null; source: string; last_price: number; last_price_source: string }[]>`
      SELECT avg_sell::float AS avg_sell, samples, trend, source,
             last_price::float AS last_price, last_price_source
      FROM ref_prices WHERE id = ${knownId}
    `)[0];
    expect(after.avg_sell).toBe(130);
    expect(after.samples).toBe(9);
    expect(after.source).toBe('test-scraper');
    expect(after.last_price).toBe(130);
    expect(after.last_price_source).toBe('scraper:test-scraper');

    const afterEvents = (await sql<{ c: number; latest_source: string; latest_actor: string | null }[]>`
      SELECT COUNT(*)::int AS c,
             (SELECT source FROM ref_price_events
              WHERE ref_price_id = ${knownId} ORDER BY created_at DESC LIMIT 1) AS latest_source,
             (SELECT actor_user_id FROM ref_price_events
              WHERE ref_price_id = ${knownId} ORDER BY created_at DESC LIMIT 1) AS latest_actor
      FROM ref_price_events WHERE ref_price_id = ${knownId}
    `)[0];
    expect(afterEvents.c).toBe(beforeEvents + 1);
    expect(afterEvents.latest_source).toBe('scraper:test-scraper');
    expect(afterEvents.latest_actor).toBeNull();
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter recycle-erp-backend test -- market-write`

Expected: FAIL on the `'updates an existing row, appends an event, recomputes trend'` block — `last_price` is null and event count didn't increase.

- [ ] **Step 3: Refactor `applyMarketWrites`**

Replace the body of `applyMarketWrites` in `apps/backend/src/lib/marketWrite.ts` (currently lines 27–87) with:

```ts
import type postgres from 'postgres';
import { marketWritesTotal } from '../metrics';
import { appendPriceEvent } from './refPriceEvents';

export type WriteSelector = { id?: string; partNumber?: string };
export type WriteValue = {
  selector: WriteSelector;
  low: string;
  high: string;
  avgSell: string;
  samples: number;
  source: string;
};
export type WriteResult = {
  updated: number;
  notFound: number;
  errors: { selector: WriteSelector; error: string }[];
};

function parseNum(s: string): number | null {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Validation errors push to `errors` and continue inside the transaction so a
// single bad row doesn't roll back the rest of the batch — the scraper sees
// the partial-success report and can retry just the failing rows.
export async function applyMarketWrites(
  sql: postgres.Sql,
  values: WriteValue[],
): Promise<WriteResult> {
  return sql.begin<WriteResult>(async (tx) => {
    const out: WriteResult = { updated: 0, notFound: 0, errors: [] };
    for (const v of values) {
      const low = parseNum(v.low), high = parseNum(v.high), avg = parseNum(v.avgSell);
      if (low === null || high === null || avg === null) {
        out.errors.push({ selector: v.selector, error: 'non-numeric low/high/avgSell' });
        marketWritesTotal.inc({ outcome: 'error' });
        continue;
      }
      if (low < 0 || high < 0 || avg < 0) {
        out.errors.push({ selector: v.selector, error: 'negative price' });
        marketWritesTotal.inc({ outcome: 'error' });
        continue;
      }
      if (!(low <= avg && avg <= high)) {
        out.errors.push({ selector: v.selector, error: 'low <= avgSell <= high required' });
        marketWritesTotal.inc({ outcome: 'error' });
        continue;
      }
      if (!Number.isInteger(v.samples) || v.samples < 0) {
        out.errors.push({ selector: v.selector, error: 'samples must be a non-negative integer' });
        marketWritesTotal.inc({ outcome: 'error' });
        continue;
      }
      const idRow = (await tx<{ id: string; prev_avg: number | null }[]>`
        SELECT id, avg_sell AS prev_avg
        FROM ref_prices
        WHERE (${v.selector.id ?? null}::text IS NOT NULL AND id::text = ${v.selector.id ?? null})
           OR (${v.selector.partNumber ?? null}::text IS NOT NULL
               AND LOWER(COALESCE(part_number,'')) = LOWER(${v.selector.partNumber ?? ''}))
        LIMIT 1
      `)[0];
      if (!idRow) {
        out.notFound++;
        marketWritesTotal.inc({ outcome: 'notfound' });
        continue;
      }
      const trend = idRow.prev_avg === null ? null : +(avg - idRow.prev_avg).toFixed(2);
      // Keep the legacy columns (low_price/high_price/avg_sell/samples/source/trend)
      // in sync — MCP + market.ts read them. last_price* + events are handled by
      // appendPriceEvent below.
      await tx`
        UPDATE ref_prices SET
          low_price = ${low},
          high_price = ${high},
          avg_sell = ${avg},
          samples = ${v.samples},
          source = ${v.source},
          trend = ${trend}
        WHERE id = ${idRow.id}
      `;
      await appendPriceEvent(tx, {
        refPriceId: idRow.id,
        price: avg,
        source: 'scraper:' + v.source,
        note: null,
        actorUserId: null,
      });
      out.updated++;
      marketWritesTotal.inc({ outcome: 'updated' });
    }
    return out;
  });
}
```

Key changes from the previous version:
- Drops the `history` JSONB append and the `newPoint` local.
- Drops `updated_at = NOW()` from the legacy UPDATE (appendPriceEvent sets it).
- Calls `appendPriceEvent` once per accepted row with `source = 'scraper:' + v.source`, `actorUserId = null`.
- Returns the same `WriteResult` shape; route at `routes/market.ts` is unchanged.

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pnpm --filter recycle-erp-backend test -- market-write`

Expected: all blocks PASS including the updated one and the existing `'reports notFound'`, `'records validation errors'`, `'413 on >500'`, and bearer-auth tests.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/lib/marketWrite.ts apps/backend/tests/market-write.test.ts
git commit -m "refactor(be): scraper batch writes ref_price_events instead of history blob"
```

---

## Task 5: Manual-entry endpoint — write the failing test

**Files:**
- Create: `apps/backend/tests/market-manual-price.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/market-manual-price.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('POST /api/market/:id/manual-price', () => {
  let managerToken: string;
  let managerId: string;
  let purchaserToken: string;
  let refPriceId: string;

  beforeAll(async () => {
    await resetDb();
    const m = await loginAs(ALEX);
    managerToken = m.token;
    managerId = m.user.id;
    purchaserToken = (await loginAs(MARCUS)).token;
    const sql = getTestDb();
    refPriceId = (await sql<{ id: string }[]>`SELECT id FROM ref_prices LIMIT 1`)[0].id;
  });

  it('200 — manager records a price; row + event update', async () => {
    const sql = getTestDb();
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      body: { price: 123.45, note: 'wing called' },
    });
    expect(r.status).toBe(200);
    const body = r.body as { lastPrice: number; lastPriceAt: string };
    expect(body.lastPrice).toBe(123.45);
    expect(typeof body.lastPriceAt).toBe('string');

    const rp = (await sql<{ last_price: number; last_price_source: string }[]>`
      SELECT last_price::float AS last_price, last_price_source
      FROM ref_prices WHERE id = ${refPriceId}
    `)[0];
    expect(rp.last_price).toBe(123.45);
    expect(rp.last_price_source).toBe(`manual:${ALEX}`);

    const ev = (await sql<{ price: number; source: string; note: string | null; actor_user_id: string | null }[]>`
      SELECT price::float AS price, source, note, actor_user_id
      FROM ref_price_events
      WHERE ref_price_id = ${refPriceId}
      ORDER BY created_at DESC LIMIT 1
    `)[0];
    expect(ev.price).toBe(123.45);
    expect(ev.source).toBe(`manual:${ALEX}`);
    expect(ev.note).toBe('wing called');
    expect(ev.actor_user_id).toBe(managerId);
  });

  it('403 — purchaser is rejected and writes nothing', async () => {
    const sql = getTestDb();
    const before = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: purchaserToken,
      body: { price: 10 },
    });
    expect(r.status).toBe(403);
    const after = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    expect(after).toBe(before);
  });

  it('400 — negative price', async () => {
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      body: { price: -5 },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('invalid_price');
  });

  it('400 — non-finite price', async () => {
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      body: { price: 'abc' as unknown as number },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('invalid_price');
  });

  it('400 — note longer than 280 chars', async () => {
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      body: { price: 50, note: 'x'.repeat(281) },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('note_too_long');
  });

  it('404 — unknown id', async () => {
    const sql = getTestDb();
    const before = (await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM ref_price_events`)[0].c;
    const r = await api('POST', '/api/market/00000000-0000-0000-0000-000000000000/manual-price', {
      token: managerToken,
      body: { price: 1 },
    });
    expect(r.status).toBe(404);
    const after = (await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM ref_price_events`)[0].c;
    expect(after).toBe(before);
  });

  it('403 — missing CSRF header', async () => {
    const r = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken,
      headers: { 'X-Requested-By': '' },
      body: { price: 50 },
    });
    expect(r.status).toBe(403);
  });

  it('two sequential POSTs append two distinct events', async () => {
    const sql = getTestDb();
    const beforeC = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    const r1 = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken, body: { price: 80 },
    });
    const r2 = await api('POST', `/api/market/${refPriceId}/manual-price`, {
      token: managerToken, body: { price: 90 },
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const afterC = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${refPriceId}
    `)[0].c;
    expect(afterC).toBe(beforeC + 2);
    const rp = (await sql<{ last_price: number }[]>`
      SELECT last_price::float AS last_price FROM ref_prices WHERE id = ${refPriceId}
    `)[0];
    expect(rp.last_price).toBe(90);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter recycle-erp-backend test -- market-manual-price`

Expected: FAIL — all blocks 404 (route does not exist).

---

## Task 6: Implement the manual-entry endpoint

**Files:**
- Modify: `apps/backend/src/routes/market.ts`

- [ ] **Step 1: Add the route**

Edit `apps/backend/src/routes/market.ts`. At the top, add the import:

```ts
import { appendPriceEvent } from '../lib/refPriceEvents';
```

Then insert this route **between** the existing `market.get('/')` block and the `market.post('/values', bearerGuard(...))` block:

```ts
// Manual price entry from the Market page. Manager-only; auth + CSRF are
// handled by the mounted middleware chain. Records one row in
// ref_price_events and bumps ref_prices.last_price* via appendPriceEvent.
market.post('/:id/manual-price', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as null | { price?: unknown; note?: unknown };
  const price = typeof body?.price === 'number' ? body.price : NaN;
  if (!Number.isFinite(price) || price < 0) {
    return c.json({ error: 'invalid_price' }, 400);
  }
  const note = typeof body?.note === 'string' ? body.note : null;
  if (note !== null && note.length > 280) {
    return c.json({ error: 'note_too_long' }, 400);
  }

  const id = c.req.param('id');
  const sql = getDb(c.env);
  const ev = await sql.begin(async (tx) => {
    const exists = (await tx<{ id: string }[]>`SELECT id FROM ref_prices WHERE id::text = ${id}`)[0];
    if (!exists) return null;
    return appendPriceEvent(tx, {
      refPriceId: exists.id,
      price,
      source: `manual:${c.var.user.email}`,
      note,
      actorUserId: c.var.user.id,
    });
  });
  if (!ev) return c.json({ error: 'not_found' }, 404);
  return c.json({ lastPrice: ev.price, lastPriceAt: ev.createdAt.toISOString() });
});
```

- [ ] **Step 2: Run the test, confirm it passes**

Run: `pnpm --filter recycle-erp-backend test -- market-manual-price`

Expected: all eight `it()` blocks PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/routes/market.ts apps/backend/tests/market-manual-price.test.ts
git commit -m "feat(be): manager-only POST /api/market/:id/manual-price"
```

---

## Task 7: Read endpoint — expose `lastPrice`, `recentPrices`, and update the test

**Files:**
- Modify: `apps/backend/src/lib/market.ts`
- Modify: `apps/backend/src/routes/market.ts`
- Modify: `apps/backend/tests/market.test.ts`

- [ ] **Step 1: Update the test**

Open `apps/backend/tests/market.test.ts`. After the existing test that asserts the shape of `GET /api/market`, add (or extend an existing one with) the following assertions. Find the first `it()` that hits `GET /api/market` and add at the end of it:

```ts
    const item = (r.body as any).items[0];
    expect(item).toHaveProperty('lastPrice');
    expect(item).toHaveProperty('lastPriceAt');
    expect(item).toHaveProperty('lastPriceSource');
    expect(item).toHaveProperty('recentPrices');
    expect(Array.isArray(item.recentPrices)).toBe(true);
    if (item.recentPrices.length >= 2) {
      const first = new Date(item.recentPrices[0].ts).getTime();
      const last = new Date(item.recentPrices[item.recentPrices.length - 1].ts).getTime();
      expect(last).toBeGreaterThanOrEqual(first); // oldest first
    }
    // avg_sell still present (MCP/legacy compatibility)
    expect(item).toHaveProperty('avgSell');
```

If `market.test.ts` does not exist or has no GET test, create a minimal one at the top of the describe (mirroring the bearer-auth setup from `market-write.test.ts` is unnecessary because `/api/market` is cookie-auth — use `loginAs(ALEX)` and pass `token` to `api()`):

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('GET /api/market', () => {
  let token: string;
  beforeAll(async () => {
    await resetDb();
    token = (await loginAs(ALEX)).token;
  });

  it('returns ref prices with last-price + recent-prices shape', async () => {
    const r = await api('GET', '/api/market', { token });
    expect(r.status).toBe(200);
    const body = r.body as { items: unknown[]; targetMargin: number };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    const item = body.items[0] as Record<string, unknown>;
    expect(item).toHaveProperty('lastPrice');
    expect(item).toHaveProperty('lastPriceAt');
    expect(item).toHaveProperty('lastPriceSource');
    expect(item).toHaveProperty('recentPrices');
    expect(Array.isArray(item.recentPrices)).toBe(true);
    expect(item).toHaveProperty('avgSell');
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter recycle-erp-backend test -- "tests/market.test.ts"`

Expected: FAIL — `lastPrice` / `recentPrices` are missing from the DTO.

- [ ] **Step 3: Update `MarketValueRow` and `formatRefPrice`**

Edit `apps/backend/src/lib/market.ts`.

Replace the `MarketValueRow` type (lines 4–34) by adding three new fields plus `recent_prices`:

```ts
export type MarketValueRow = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  form_factor: string | null;
  description: string | null;
  part_number: string | null;
  label: string;
  sub_label: string | null;
  target: number | null;
  low_price: number | null;
  high_price: number | null;
  avg_sell: number | null;
  trend: number | null;
  samples: number | null;
  source: string | null;
  stock: number | null;
  demand: number | null;
  history: unknown;
  updated_at: Date;
  health: number | null;
  rpm: number | null;
  internal_avg: number | null;
  internal_samples: number | null;
  last_price: number | null;
  last_price_at: Date | null;
  last_price_source: string | null;
  recent_prices: { ts: string; price: number }[] | null;
};
```

Replace the `MarketValue` type (lines 36–71) — add the four new fields:

```ts
export type MarketValue = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  formFactor: string | null;
  description: string | null;
  partNumber: string | null;
  label: string;
  sub: string | null;
  target: number | null;
  low: number | null;
  high: number | null;
  avgSell: number | null;
  trend: number | null;
  samples: number | null;
  source: string | null;
  stock: number | null;
  demand: number | null;
  history: unknown;
  updatedAt: string;
  maxBuy: number | null;
  health: number | null;
  rpm: number | null;
  internalSales: { avgPrice: number | null; samples: number };
  lastPrice: number | null;
  lastPriceAt: string | null;
  lastPriceSource: string | null;
  recentPrices: { ts: string; price: number }[];
};
```

Replace the body of `formatRefPrice` (lines 73–108) with:

```ts
export function formatRefPrice(r: MarketValueRow, targetMargin: number): MarketValue {
  // maxBuy migrates to last_price as the basis (more meaningful with few
  // samples). Falls back to avg_sell when no recorded last_price yet — same
  // numeric behaviour as before for un-touched rows.
  const basis = r.last_price ?? r.avg_sell;
  return {
    id: r.id,
    category: r.category,
    brand: r.brand,
    capacity: r.capacity,
    type: r.type,
    classification: r.classification,
    rank: r.rank,
    speed: r.speed,
    interface: r.interface,
    formFactor: r.form_factor,
    description: r.description,
    partNumber: r.part_number,
    label: r.label,
    sub: r.sub_label,
    target: r.target,
    low: r.low_price,
    high: r.high_price,
    avgSell: r.avg_sell,
    trend: r.trend,
    samples: r.samples,
    source: r.source,
    stock: r.stock,
    demand: r.demand,
    history: r.history,
    updatedAt: r.updated_at.toISOString(),
    maxBuy: basis === null ? null : +(basis * (1 - targetMargin)).toFixed(2),
    health: r.health,
    rpm: r.rpm,
    internalSales: {
      avgPrice: r.internal_avg == null ? null : +r.internal_avg.toFixed(2),
      samples: r.internal_samples ?? 0,
    },
    lastPrice: r.last_price === null ? null : +r.last_price.toFixed(2),
    lastPriceAt: r.last_price_at ? r.last_price_at.toISOString() : null,
    lastPriceSource: r.last_price_source,
    recentPrices: r.recent_prices ?? [],
  };
}
```

- [ ] **Step 4: Extend the SQL in `GET /api/market`**

Open `apps/backend/src/routes/market.ts`. Replace the `SELECT … FROM ref_prices rp LEFT JOIN internal_sales ils …` block in the `market.get('/')` handler so it (a) selects the three new columns, (b) joins a LATERAL subquery returning a JSONB array of the last 12 events oldest-first:

```ts
  const rows = await sql<MarketValueRow[]>`
    WITH internal_sales AS (
      SELECT UPPER(REGEXP_REPLACE(
               REGEXP_REPLACE(COALESCE(l.part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
               '[[:space:]]+', '', 'g'
             )) AS canon,
             AVG(l.sell_price)::float AS avg_price,
             COUNT(*)::int AS samples
      FROM order_lines l
      JOIN orders o ON o.id = l.order_id
      WHERE o.created_at >= NOW() - INTERVAL '30 days'
        AND l.sell_price IS NOT NULL
        AND l.part_number IS NOT NULL
        AND l.part_number <> ''
      GROUP BY canon
    )
    SELECT rp.id, rp.category, rp.brand, rp.capacity, rp.type, rp.classification,
           rp.rank, rp.speed, rp.interface, rp.form_factor, rp.description,
           rp.part_number, rp.label, rp.sub_label,
           rp.target::float AS target, rp.low_price::float AS low_price,
           rp.high_price::float AS high_price, rp.avg_sell::float AS avg_sell,
           rp.trend, rp.samples, rp.source, rp.stock, rp.demand, rp.history,
           rp.updated_at, rp.health::float AS health, rp.rpm,
           ils.avg_price AS internal_avg,
           ils.samples   AS internal_samples,
           rp.last_price::float AS last_price,
           rp.last_price_at AS last_price_at,
           rp.last_price_source AS last_price_source,
           rec.recent AS recent_prices
    FROM ref_prices rp
    LEFT JOIN internal_sales ils
      ON ils.canon = UPPER(REGEXP_REPLACE(
                       REGEXP_REPLACE(COALESCE(rp.part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
                       '[[:space:]]+', '', 'g'
                     ))
    LEFT JOIN LATERAL (
      SELECT JSONB_AGG(
               JSONB_BUILD_OBJECT('ts', e.created_at, 'price', e.price::float)
               ORDER BY e.created_at
             ) AS recent
      FROM (
        SELECT created_at, price FROM ref_price_events
        WHERE ref_price_id = rp.id
        ORDER BY created_at DESC LIMIT 12
      ) e
    ) rec ON TRUE
    WHERE (${category ?? null}::text IS NULL OR rp.category = ${category ?? null})
      AND (
        ${search ?? null}::text IS NULL
        OR LOWER(rp.label) LIKE '%' || ${search ?? ''} || '%'
        OR LOWER(COALESCE(rp.part_number,'')) LIKE '%' || ${search ?? ''} || '%'
      )
    ORDER BY rp.updated_at DESC
    LIMIT 100
  `;
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `pnpm --filter recycle-erp-backend test -- "tests/market.test.ts"`

Expected: PASS.

Then run the full market suite to confirm nothing regressed:

Run: `pnpm --filter recycle-erp-backend test -- market`

Expected: all `market*.test.ts` files green.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/lib/market.ts apps/backend/src/routes/market.ts apps/backend/tests/market.test.ts
git commit -m "feat(be): expose lastPrice/recentPrices on /api/market and migrate maxBuy basis"
```

---

## Task 8: Seed — populate `ref_price_events` + `last_price*` on reset

**Files:**
- Modify: `apps/backend/scripts/seed.mjs`

The seed currently builds a `p.history` array of 12 weekly synthetic prices per SKU and inserts only into `ref_prices`. We need to also insert 12 corresponding rows into `ref_price_events` (so the sparkline has data) and set `last_price*` to the latest one.

- [ ] **Step 1: Modify the ref_prices insert + add the events insert**

Open `apps/backend/scripts/seed.mjs`. Find the block starting around line 487 (`console.log('· Seeding ref_prices…');`) and replace through the end of the loop (the closing `}` after the `INSERT INTO ref_prices` statement, around line 505) with:

```js
  console.log('· Seeding ref_prices…');
  await sql`DELETE FROM ref_price_events`;
  await sql`DELETE FROM ref_prices`;
  for (const p of buildRefPrices()) {
    // Spread the synthetic 12-point history across the last 12 weeks
    // ending at the row's updated_at. Newest entry is the last_price.
    const ts = [];
    const baseMs = +new Date(p.updated_at);
    for (let i = 0; i < p.history.length; i++) {
      ts.push(new Date(baseMs - (p.history.length - 1 - i) * 7 * 86400000));
    }
    const lastIdx = p.history.length - 1;
    const lastPrice = p.history[lastIdx];
    const lastTs = ts[lastIdx];

    await sql`
      INSERT INTO ref_prices (
        id, category, brand, capacity, type, classification, rank, speed,
        interface, form_factor, description, part_number,
        label, sub_label, target, low_price, high_price, avg_sell,
        trend, samples, source, stock, demand, history, updated_at,
        rpm, last_price, last_price_at, last_price_source
      ) VALUES (
        ${p.id}, ${p.category}, ${p.brand ?? null}, ${p.capacity ?? null}, ${p.type ?? null}, ${p.classification ?? null}, ${p.rank ?? null}, ${p.speed ?? null},
        ${p.interface ?? null}, ${p.form_factor ?? null}, ${p.description ?? null}, ${p.part_number},
        ${p.label}, ${p.sub_label}, ${p.target}, ${p.low_price}, ${p.high_price}, ${p.avg_sell},
        ${p.trend}, ${p.samples}, ${p.source}, ${p.stock}, ${p.demand}, ${sql.json(p.history)}, ${p.updated_at},
        ${p.rpm ?? null}, ${lastPrice}, ${lastTs}, 'seed'
      )
    `;
    for (let i = 0; i < p.history.length; i++) {
      await sql`
        INSERT INTO ref_price_events (ref_price_id, price, source, note, actor_user_id, created_at)
        VALUES (${p.id}, ${p.history[i]}, 'seed', NULL, NULL, ${ts[i]})
      `;
    }
  }
```

- [ ] **Step 2: Reset the dev DB and verify**

Run: `pnpm db:reset`

Expected: completes without error, prints `· Seeding ref_prices…`.

Run: `docker exec recycle_pg psql -U recycle -d recycle_erp -c "SELECT id, last_price, last_price_source FROM ref_prices WHERE last_price IS NOT NULL LIMIT 3;"`

Expected: three rows with non-null `last_price` and `last_price_source = 'seed'`.

Run: `docker exec recycle_pg psql -U recycle -d recycle_erp -c "SELECT COUNT(*) FROM ref_price_events;"`

Expected: roughly 12 × (number of ref_prices) rows.

- [ ] **Step 3: Run the full backend test suite**

Run: `pnpm --filter recycle-erp-backend test`

Expected: all tests pass.  (resetDb runs the seed, so this catches any seed regressions.)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/scripts/seed.mjs
git commit -m "feat(seed): populate last_price + ref_price_events from synthetic history"
```

---

## Task 9: Frontend types — add the new fields

**Files:**
- Modify: `apps/frontend/src/lib/types.ts`

- [ ] **Step 1: Extend `RefPrice`**

Open `apps/frontend/src/lib/types.ts`. Find the `RefPrice` type (around lines 142–173) and add four fields. Locate the line `  internalSales: { avgPrice: number | null; samples: number };` and replace it with:

```ts
  internalSales: { avgPrice: number | null; samples: number };
  lastPrice: number | null;
  lastPriceAt: string | null;
  lastPriceSource: string | null;
  recentPrices: { ts: string; price: number }[];
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter recycle-erp-frontend exec tsc -p tsconfig.app.json --noEmit`

Expected: PASS (the new fields are additions; existing usage stays compatible).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/lib/types.ts
git commit -m "types(fe): RefPrice gains lastPrice/lastPriceAt/lastPriceSource/recentPrices"
```

---

## Task 10: Staleness helper + unit test

**Files:**
- Create: `apps/frontend/src/pages/desktop/marketStaleness.ts`
- Create: `apps/frontend/src/pages/desktop/marketStaleness.test.ts`

Extract the staleness logic to its own module so we can unit-test it without rendering the page.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/pages/desktop/marketStaleness.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { staleness, STALE_DAYS } from './marketStaleness';

describe('staleness', () => {
  const now = new Date('2026-05-23T12:00:00Z').getTime();

  it('returns isStale=true for null lastPriceAt', () => {
    expect(staleness(null, now)).toEqual({ days: null, isStale: true });
  });

  it('returns isStale=false at exactly STALE_DAYS', () => {
    const ts = new Date(now - STALE_DAYS * 86400000).toISOString();
    const s = staleness(ts, now);
    expect(s.days).toBe(STALE_DAYS);
    expect(s.isStale).toBe(false);
  });

  it('returns isStale=true at STALE_DAYS + 1', () => {
    const ts = new Date(now - (STALE_DAYS + 1) * 86400000).toISOString();
    const s = staleness(ts, now);
    expect(s.days).toBe(STALE_DAYS + 1);
    expect(s.isStale).toBe(true);
  });

  it('returns isStale=false for a fresh today timestamp', () => {
    const ts = new Date(now - 60_000).toISOString();
    const s = staleness(ts, now);
    expect(s.days).toBe(0);
    expect(s.isStale).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter recycle-erp-frontend test -- marketStaleness`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/frontend/src/pages/desktop/marketStaleness.ts`:

```ts
export const STALE_DAYS = 5;

export function staleness(
  lastPriceAt: string | null,
  now: number = Date.now(),
): { days: number | null; isStale: boolean } {
  if (!lastPriceAt) return { days: null, isStale: true };
  const days = Math.floor((now - +new Date(lastPriceAt)) / 86_400_000);
  return { days, isStale: days > STALE_DAYS };
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pnpm --filter recycle-erp-frontend test -- marketStaleness`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/marketStaleness.ts apps/frontend/src/pages/desktop/marketStaleness.test.ts
git commit -m "feat(fe): staleness helper for Market page (5-day window)"
```

---

## Task 11: Wire `lastPrice` and stale styling into the Market table

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopMarket.tsx`

We swap the headline column from `avgSell` to `lastPrice`, drive the sparkline off `recentPrices`, derive `maxBuy` from `lastPrice` instead of `avgSell`, and add red styling + a stale badge when `staleness(...).isStale`.

- [ ] **Step 1: Add the helper import**

At the top of `apps/frontend/src/pages/desktop/DesktopMarket.tsx`, after the existing imports, add:

```ts
import { staleness, STALE_DAYS } from './marketStaleness';
```

- [ ] **Step 2: Switch the sparkline source and remove the fake-sell markup**

In the `rows.slice(0, 40).map(r => { … })` block, replace the line:

```ts
                const sellHistory = r.history.map(c => +(c * 1.35).toFixed(2));
```

with:

```ts
                const sellHistory = r.recentPrices.map(p => p.price);
                const stale = staleness(r.lastPriceAt);
```

- [ ] **Step 3: Re-derive `maxBuy` from `lastPrice`**

The `allRows` memo currently computes maxBuy from `avgSell`:

```ts
  const allRows = useMemo(
    () => items.map(p => ({
      ...p,
      maxBuy: p.maxBuy || +(p.avgSell * (1 - targetMargin)).toFixed(2),
    })),
    [items, targetMargin],
  );
```

Replace it with:

```ts
  const allRows = useMemo(
    () => items.map(p => {
      // Prefer the recorded last_price over avg_sell as the basis. Both can be
      // null on brand-new rows; if so, leave maxBuy null and the cell renders an
      // em-dash.
      const basis = p.lastPrice ?? p.avgSell;
      const maxBuy = p.maxBuy != null
        ? p.maxBuy
        : basis != null ? +(basis * (1 - targetMargin)).toFixed(2) : null;
      return { ...p, maxBuy };
    }),
    [items, targetMargin],
  );
```

Also change the row type in the rendering block. Find `(r) => { const isOpen = …` block and adjust `maxBuy: number` references — currently `r.maxBuy` is treated as `number`, now it can be `null`. In the JSX:

Find:

```tsx
                      <td className="num">
                        <div style={{
                          display: 'inline-flex', alignItems: 'baseline', gap: 4,
                          padding: '4px 8px', borderRadius: 6,
                          background: 'color-mix(in oklch, var(--accent) 8%, transparent)',
                          border: '1px dashed color-mix(in oklch, var(--accent) 35%, transparent)',
                        }}>
                          <span style={{ fontSize: 10, color: 'var(--accent-strong)', fontWeight: 600 }}>≤</span>
                          <span className="mono" style={{ fontWeight: 600, color: 'var(--accent-strong)' }}>{fmtUSD(r.maxBuy, locale)}</span>
                        </div>
                      </td>
```

Replace with:

```tsx
                      <td className="num">
                        {r.maxBuy == null ? (
                          <span className="mono muted">—</span>
                        ) : (
                          <div style={{
                            display: 'inline-flex', alignItems: 'baseline', gap: 4,
                            padding: '4px 8px', borderRadius: 6,
                            background: 'color-mix(in oklch, var(--accent) 8%, transparent)',
                            border: '1px dashed color-mix(in oklch, var(--accent) 35%, transparent)',
                          }}>
                            <span style={{ fontSize: 10, color: 'var(--accent-strong)', fontWeight: 600 }}>≤</span>
                            <span className="mono" style={{ fontWeight: 600, color: 'var(--accent-strong)' }}>{fmtUSD(r.maxBuy, locale)}</span>
                          </div>
                        )}
                      </td>
```

- [ ] **Step 4: Replace the "Avg sell price" column header and cell**

Find the `<th>` block in `<thead>`:

```tsx
                <th className="num" style={{ color: 'var(--pos)' }}>Avg sell price</th>
```

Replace with:

```tsx
                <th className="num" style={{ color: 'var(--pos)' }}>Last sell price</th>
```

Find the cell that currently renders `r.avgSell`:

```tsx
                      <td className="num">
                        <div className="mono" style={{ fontWeight: 600, fontSize: 14, color: 'var(--pos)' }}>{fmtUSD(r.avgSell, locale)}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>n = {r.samples}</div>
                      </td>
```

Replace with:

```tsx
                      <td className="num">
                        {r.lastPrice == null ? (
                          <div className="mono muted">—</div>
                        ) : (
                          <div
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 6,
                              padding: stale.isStale ? '2px 8px' : 0,
                              borderRadius: 6,
                              background: stale.isStale
                                ? 'color-mix(in oklch, var(--neg) 8%, transparent)'
                                : 'transparent',
                            }}
                            title={stale.isStale ? `No update in the last ${STALE_DAYS} days — manually refresh` : undefined}
                          >
                            {stale.isStale && (
                              <Icon name="alertTriangle" size={11} style={{ color: 'var(--neg)' }} />
                            )}
                            <span
                              className="mono"
                              style={{
                                fontWeight: 600, fontSize: 14,
                                color: stale.isStale ? 'var(--neg)' : 'var(--pos)',
                              }}
                            >{fmtUSD(r.lastPrice, locale)}</span>
                          </div>
                        )}
                        <div style={{ fontSize: 10.5, color: stale.isStale ? 'var(--neg)' : 'var(--fg-subtle)' }}>
                          {r.lastPriceAt
                            ? `${relTime(r.lastPriceAt, locale)}${stale.isStale ? ' · stale' : ''}`
                            : `no data · stale`}
                        </div>
                      </td>
```

- [ ] **Step 5: Update the footer caption**

Find:

```tsx
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="info" size={11} />
            Max buy = avg sell × (1 − {(targetMargin * 100).toFixed(0)}% target margin)
          </div>
```

Replace with:

```tsx
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="info" size={11} />
            Max buy = last sell × (1 − {(targetMargin * 100).toFixed(0)}% target margin) · stale = no update in {STALE_DAYS}+ days
          </div>
```

- [ ] **Step 6: Use `recentPrices` in the detail panel chart**

In the expanded `DetailExpand` component (further down the file) the dual-line chart receives `sellHistory` from the calling row — already updated in Step 2 to come from `recentPrices`. Find the `buyHistory` line inside `DetailExpand`:

```ts
  const buyHistory = row.history;
```

Replace with:

```ts
  // Cost series is still synthetic — out of scope for this slice.
  const buyHistory = (row.recentPrices ?? []).map(p => +(p.price * 0.7).toFixed(2));
```

- [ ] **Step 7: Update confidence to honour staleness**

Find the Confidence block in `DetailExpand`:

```tsx
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--fg-subtle)' }}>
          Confidence:{' '}
          <strong style={{ color: row.samples > 20 ? 'var(--pos)' : row.samples > 10 ? 'var(--warn)' : 'var(--neg)' }}>
            {row.samples > 20 ? 'High' : row.samples > 10 ? 'Medium' : 'Low'}
          </strong>{' '}
          — based on {row.samples} data points across {priceSources.length} sources.
        </div>
```

Replace with:

```tsx
        {(() => {
          const stale = staleness(row.lastPriceAt);
          const label = stale.isStale
            ? 'Stale'
            : row.samples > 20 ? 'High' : row.samples > 10 ? 'Medium' : 'Low';
          const color = stale.isStale
            ? 'var(--neg)'
            : row.samples > 20 ? 'var(--pos)' : row.samples > 10 ? 'var(--warn)' : 'var(--neg)';
          return (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--fg-subtle)' }}>
              Confidence: <strong style={{ color }}>{label}</strong>{' '}
              — based on {row.samples} data points across {priceSources.length} sources.
            </div>
          );
        })()}
```

- [ ] **Step 8: Typecheck and visually verify**

Run: `pnpm --filter recycle-erp-frontend exec tsc -p tsconfig.app.json --noEmit`

Expected: PASS.

Then start the dev stack (`pnpm dev` from repo root) if not already running and visit `http://localhost:5173/market`. Expect:
- Column header reads "Last sell price".
- Most rows show a red price with a small ⚠ icon, an `N days ago · stale` sub-line, and a red Confidence badge in the detail panel (since seed data is 1–21 days old).
- A few rows (those within 5 days) are green and read "Steady"/"Medium"/"High".
- Max-buy chip is present where `lastPrice` exists; em-dash where it does not.
- Footer caption ends with `… stale = no update in 5+ days`.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopMarket.tsx
git commit -m "feat(fe): show last_price + 5d stale signal on Market; maxBuy from lastPrice"
```

---

## Task 12: Manager-only inline pencil + popover

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopMarket.tsx`
- Modify: `apps/frontend/src/lib/i18n.tsx`

- [ ] **Step 1: Add i18n strings**

Open `apps/frontend/src/lib/i18n.tsx`. It exports `I18N: Record<Lang, Record<string, string>>` with `en` and `zh` flat dictionaries. Add four keys to **each** locale (alphabetical order; place near the existing `marketValue` key):

```ts
// inside I18N.en
marketUpdatePrice: 'Update price',
marketPriceNotePlaceholder: 'Optional note — broker, source',
marketSave: 'Save',
marketCancel: 'Cancel',
```

```ts
// inside I18N.zh
marketUpdatePrice: '更新价格',
marketPriceNotePlaceholder: '可选备注 — 报价方、来源',
marketSave: '保存',
marketCancel: '取消',
```

- [ ] **Step 2: Add imports + useAuth hook**

At the top of `apps/frontend/src/pages/desktop/DesktopMarket.tsx`, after the existing imports:

```ts
import { useAuth } from '../../lib/auth';
```

Then inside `DesktopMarket`, near the top of the component body alongside other `useState` calls:

```ts
  const { user } = useAuth();
  const isManager = user?.role === 'manager';
  const [editing, setEditing] = useState<null | { row: RefPrice & { maxBuy: number | null } }>(null);
```

- [ ] **Step 3: Add the pencil button inside the Last-price cell**

Inside the Last-price `<td>` (the one you just rebuilt in Task 11), wrap the existing content in a flex row and add a pencil button at the right edge that is visible only on hover and only to managers.

Change the `<td className="num">` block to:

```tsx
                      <td className="num" style={{ position: 'relative' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                          <div>
                            {r.lastPrice == null ? (
                              <div className="mono muted">—</div>
                            ) : (
                              <div
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 6,
                                  padding: stale.isStale ? '2px 8px' : 0,
                                  borderRadius: 6,
                                  background: stale.isStale
                                    ? 'color-mix(in oklch, var(--neg) 8%, transparent)'
                                    : 'transparent',
                                }}
                                title={stale.isStale ? `No update in the last ${STALE_DAYS} days — manually refresh` : undefined}
                              >
                                {stale.isStale && (
                                  <Icon name="alertTriangle" size={11} style={{ color: 'var(--neg)' }} />
                                )}
                                <span
                                  className="mono"
                                  style={{
                                    fontWeight: 600, fontSize: 14,
                                    color: stale.isStale ? 'var(--neg)' : 'var(--pos)',
                                  }}
                                >{fmtUSD(r.lastPrice, locale)}</span>
                              </div>
                            )}
                            <div style={{ fontSize: 10.5, color: stale.isStale ? 'var(--neg)' : 'var(--fg-subtle)' }}>
                              {r.lastPriceAt
                                ? `${relTime(r.lastPriceAt, locale)}${stale.isStale ? ' · stale' : ''}`
                                : `no data · stale`}
                            </div>
                          </div>
                          {isManager && (
                            <button
                              type="button"
                              className="pencil-btn"
                              aria-label={t('marketUpdatePrice')}
                              title={t('marketUpdatePrice')}
                              onClick={(e) => { e.stopPropagation(); setEditing({ row: r }); }}
                              style={{
                                opacity: 0, transition: 'opacity 120ms',
                                background: 'transparent', border: 'none', cursor: 'pointer',
                                color: 'var(--fg-subtle)', padding: 4, borderRadius: 4,
                              }}
                            >
                              <Icon name="edit" size={13} />
                            </button>
                          )}
                        </div>
                      </td>
```

Add a `<style>` block once near the top of the returned JSX (inside the outer `<>`, before `<div className="page-head">`):

```tsx
      <style>{`
        .row-hover:hover .pencil-btn { opacity: 1; }
      `}</style>
```

(`Icon name="edit"` is the existing pencil glyph — confirmed in `apps/frontend/src/components/Icon.tsx`.)

- [ ] **Step 4: Render the edit popover**

Below the `<table>` (still inside the `<div className="card">`, after the footer), render the popover conditionally. Add this snippet just before the closing `</div>` of the card:

```tsx
        {editing && (
          <ManualPriceDialog
            row={editing.row}
            onClose={() => setEditing(null)}
            onSaved={(price, atIso) => {
              setItems(prev => prev.map(it => it.id === editing.row.id
                ? { ...it, lastPrice: price, lastPriceAt: atIso,
                    recentPrices: [...(it.recentPrices ?? []), { ts: atIso, price }].slice(-12) }
                : it));
              setEditing(null);
            }}
          />
        )}
```

Then add the `ManualPriceDialog` component at the bottom of the file (below `DualLineChart`):

```tsx
function ManualPriceDialog({
  row, onClose, onSaved,
}: {
  row: RefPrice & { maxBuy: number | null };
  onClose: () => void;
  onSaved: (price: number, atIso: string) => void;
}) {
  const { t } = useT();
  const [price, setPrice] = useState<string>(row.lastPrice == null ? '' : String(row.lastPrice));
  const [note, setNote] = useState<string>('');
  const [saving, setSaving] = useState(false);

  async function save() {
    const n = Number(price);
    if (!Number.isFinite(n) || n < 0) return;
    setSaving(true);
    try {
      const r = await api.post<{ lastPrice: number; lastPriceAt: string }>(
        `/api/market/${row.id}/manual-price`,
        { price: n, note: note.trim() || undefined },
      );
      onSaved(r.lastPrice, r.lastPriceAt);
    } catch (err) {
      handleFetchError(err);
    } finally {
      setSaving(false);
    }
  }

  // Backdrop is a click-to-close; Esc closes; Cmd/Ctrl+Enter saves.
  return (
    <div
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
      }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)',
        display: 'grid', placeItems: 'center', zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320, background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 12, padding: 18, boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>{row.label}</div>
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginBottom: 14 }}>{row.partNumber ?? '—'}</div>
        <label style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'block', marginBottom: 4 }}>USD</label>
        <input
          className="input"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          autoFocus
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          style={{ width: '100%', fontSize: 16, marginBottom: 12 }}
        />
        <input
          className="input"
          type="text"
          maxLength={280}
          placeholder={t('marketPriceNotePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{ width: '100%', fontSize: 12, marginBottom: 14 }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>{t('marketCancel')}</button>
          <button
            type="button"
            className="btn primary"
            onClick={save}
            disabled={saving || !Number.isFinite(Number(price)) || Number(price) < 0}
          >{saving ? '…' : t('marketSave')}</button>
        </div>
      </div>
    </div>
  );
}
```

(Class names `btn`, `btn primary`, `input` are existing utilities — verify by opening `apps/frontend/src/index.css` if anything renders unstyled.)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter recycle-erp-frontend exec tsc -p tsconfig.app.json --noEmit`

Expected: PASS.

- [ ] **Step 6: Visually verify in dev**

Start the dev stack if it's not already running (`pnpm dev`). Log in as a manager (`alex@recycleservers.io` / `demo`).
- Hover a Market row: pencil appears at the right edge of the Last-price cell.
- Click it: popover opens, prefilled with the current `lastPrice`. Type a different number, optionally a note, hit Save.
- The row updates immediately (optimistic), the price turns green, the "N days ago · stale" sub-line becomes "just now".
- Reload the page: the value persists, the sub-line reflects the new timestamp.
- Log in as a purchaser (`marcus@recycleservers.io` / `demo`): pencil is not rendered, and direct POST returns 403 (proven by the backend tests).
- Press Esc → popover closes without saving. Type a value and press Cmd/Ctrl+Enter → saves.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopMarket.tsx apps/frontend/src/lib/i18n.tsx
git commit -m "feat(fe): manager-only inline manual price entry on Market page"
```

---

## Task 13: "Show stale only" filter

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopMarket.tsx`
- Modify: `apps/frontend/src/lib/preferences.tsx`
- Modify: `apps/backend/src/preferences.ts`

The preferences module is server-backed (`users.preferences` JSONB) with a typed `PrefMap` in the frontend and an allowlist `SCHEMA` in the backend. Both need a new key. Consumers call `usePreference('key', fallback)`.

- [ ] **Step 1a: Add the key to the frontend `PrefMap`**

In `apps/frontend/src/lib/preferences.tsx`, find the `export type PrefMap = { … }` block (around line 27) and add one line:

```ts
  'market.showStaleOnly': boolean;
```

- [ ] **Step 1b: Add the key to the backend allowlist**

In `apps/backend/src/preferences.ts`, find the `SCHEMA` object (around line 18) and add one entry plus a tiny boolean validator above it if one doesn't already exist:

```ts
const isBoolean: Validator = (v) => typeof v === 'boolean';
```

```ts
// inside SCHEMA
  'market.showStaleOnly':     isBoolean,
```

- [ ] **Step 2: Add the i18n string**

In `apps/frontend/src/lib/i18n.tsx`, add `marketShowStaleOnly` → "Show stale only" / "仅显示陈旧".

- [ ] **Step 3: Wire the toggle into the page**

In `DesktopMarket.tsx`, add the import:

```ts
import { usePreference } from '../../lib/preferences';
```

Then inside `DesktopMarket`, alongside the other `useState` calls:

```ts
  const [showStaleOnly, setShowStaleOnly] = usePreference('market.showStaleOnly', false);
```

In the card head, next to the existing sort `<select>`, add:

```tsx
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-muted)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showStaleOnly}
                onChange={(e) => setShowStaleOnly(e.target.checked)}
              />
              {t('marketShowStaleOnly')}
            </label>
```

In the `rows` memo, after the sort step, filter:

```ts
    if (showStaleOnly) {
      return arr.filter(p => staleness(p.lastPriceAt).isStale);
    }
    return arr;
```

Add `showStaleOnly` to the dependency array of that memo.

- [ ] **Step 4: Typecheck and verify**

Run: `pnpm --filter recycle-erp-frontend exec tsc -p tsconfig.app.json --noEmit`

Expected: PASS.

In the browser, toggle the checkbox: the table filters to red rows only. Refresh: setting persists.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopMarket.tsx apps/frontend/src/lib/preferences.tsx apps/frontend/src/lib/i18n.tsx
git commit -m "feat(fe): Show stale only toggle on Market page (persists)"
```

---

## Task 14: Full-suite green sweep

**Files:** none

- [ ] **Step 1: Backend suite**

Run: `pnpm --filter recycle-erp-backend test`

Expected: all tests pass.  If the run goes flaky (catalog-DDL races per the test-harness convention), retry once; investigate only if the same test fails twice in a row.

- [ ] **Step 2: Frontend suite**

Run: `pnpm --filter recycle-erp-frontend test`

Expected: all tests pass.

- [ ] **Step 3: Workspace typecheck + build**

Run: `pnpm typecheck && pnpm build`

Expected: both succeed.

- [ ] **Step 4: Push**

Run: `git push origin main`

Expected: push succeeds, CI (if any) goes green.

---

## Out of scope (do not implement in this plan)

- Mobile Market manual entry.
- Dropping the legacy `ref_prices.history` JSONB column (follow-up after we confirm nothing reads it for a release cycle).
- A real cost series on the detail-panel chart (currently a 0.7× synthetic of recentPrices).
- Bulk CSV import or per-row "lock for N days" precedence flag.
- Mobile/vendor shell changes.
