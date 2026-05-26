# Multi-currency Vendor Bids Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let vendors quote bids in CNY as well as USD, with rates pulled daily from Frankfurter (free ECB-backed API) and a manager override surface. Sell-order lines stay USD-denominated; source currency/rate are stored for audit.

**Architecture:** One migration (0056) adds `fx_rates` ledger + audit columns. A new `lib/fx.ts` module keeps the ledger fresh on a 6-hour timer and exposes a small lookup API. Existing `vendorPublic` POST stores the bid's currency + rate at submit; existing `vendorBids` promote re-snapshots rate and stamps audit columns on the new SO line. A new manager-only `/api/workspace/fx-rates` route powers a Settings panel with refresh + manual override. Frontend gains a currency picker on the vendor portal, a Currency column + FX badge on staff bid views, and a new `fmtMoney` helper.

**Tech Stack:** PostgreSQL 16, Hono on Node 22 (`postgres.js`), Vitest with real Postgres, React + Vite. No new runtime dependencies; uses Node's built-in `fetch` for Frankfurter and `undici` MockAgent for tests (already transitively available).

**Spec:** `docs/superpowers/specs/2026-05-26-multi-currency-vendor-bids-design.md`

---

## File map

**Created:**
- `apps/backend/migrations/0056_multi_currency.sql` — schema migration
- `apps/backend/src/lib/fx.ts` — FX fetcher, ledger, lookup helpers
- `apps/backend/src/routes/fxRates.ts` — manager-only `/api/workspace/fx-rates` router
- `apps/backend/tests/fx-fetcher.test.ts`
- `apps/backend/tests/fx-routes.test.ts`
- `apps/backend/tests/vendor-public-bid-currency.test.ts`
- `apps/backend/tests/vendor-bid-promote-fx.test.ts`
- `apps/frontend/src/components/FxRatesPanel.tsx` — settings panel
- `apps/frontend/src/lib/format.test.ts` — pure test for `fmtMoney`

**Modified:**
- `apps/backend/src/server.ts` — boot-time `startFxRefreshLoop()` call
- `apps/backend/src/index.ts` — mount `fxRatesRoutes`, add public `/fx` GET
- `apps/backend/src/routes/vendorPublic.ts` — accept currency on POST, return currency on GET, add `/fx` public endpoint
- `apps/backend/src/routes/vendorBids.ts` — re-snapshot rate at promote, write audit cols + event detail, return currency in list/detail
- `apps/frontend/src/lib/format.ts` — add `fmtMoney`
- `apps/frontend/src/lib/i18n.tsx` — new currency/FX translation keys
- `apps/frontend/src/VendorApp.tsx` — currency picker + live USD-equiv subtotal
- `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx` — Currency column, USD-equiv totals, FX badge, accepted-USD hint, promote button label, filter chip
- `apps/frontend/src/pages/desktop/DesktopWorkspace.tsx` (or wherever workspace settings live) — embed `FxRatesPanel`

---

### Task 1: Migration 0056 — schema

**Files:**
- Create: `apps/backend/migrations/0056_multi_currency.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Multi-currency vendor bids: USD remains the company's reporting currency,
-- but vendors may quote in CNY (RMB). A ledger of FX rates feeds a frozen
-- snapshot on each vendor_bid (at submit) and again on each sell_order_line
-- (at promote). Sell-order totals stay USD; source-currency facts live in
-- audit columns so SO history can show the original quote.

CREATE TABLE IF NOT EXISTS fx_rates (
  id              BIGSERIAL PRIMARY KEY,
  base_currency   CHAR(3)       NOT NULL,
  quote_currency  CHAR(3)       NOT NULL,
  rate            NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  source          TEXT          NOT NULL,
  fetched_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  effective_date  DATE          NOT NULL,
  note            TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (base_currency IN ('USD')),
  CHECK (quote_currency IN ('CNY')),
  CHECK (source IN ('frankfurter','manual'))
);
CREATE INDEX IF NOT EXISTS fx_rates_pair_fetched
  ON fx_rates (base_currency, quote_currency, fetched_at DESC);

ALTER TABLE vendor_bids
  ADD COLUMN IF NOT EXISTS currency_code  CHAR(3)       NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS fx_rate_to_usd NUMERIC(18,8) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_source      TEXT          NOT NULL DEFAULT 'manual';

ALTER TABLE vendor_bids
  DROP CONSTRAINT IF EXISTS vendor_bids_currency_ck;
ALTER TABLE vendor_bids
  ADD CONSTRAINT vendor_bids_currency_ck CHECK (currency_code IN ('USD','CNY'));

ALTER TABLE sell_order_lines
  ADD COLUMN IF NOT EXISTS source_currency       CHAR(3),
  ADD COLUMN IF NOT EXISTS source_unit_price     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS source_fx_rate_to_usd NUMERIC(18,8);
```

- [ ] **Step 2: Run migrations**

```bash
pnpm db:migrate
```

Expected: `0056_multi_currency.sql applied` printed in the log.

- [ ] **Step 3: Verify schema in psql**

```bash
PGPASSWORD=recycle psql -h 127.0.0.1 -U recycle -d recycle -c "\d fx_rates" -c "\d vendor_bids" -c "\d sell_order_lines"
```

Expected: `fx_rates` exists with all columns; `vendor_bids` has `currency_code`/`fx_rate_to_usd`/`fx_source`; `sell_order_lines` has `source_currency`/`source_unit_price`/`source_fx_rate_to_usd`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0056_multi_currency.sql
git commit -m "feat(db): mig 0056 multi-currency fx_rates ledger + bid/SO audit cols"
```

---

### Task 2: FX module — pure helpers + test

**Files:**
- Create: `apps/backend/src/lib/fx.ts`
- Create: `apps/backend/tests/fx-fetcher.test.ts`

- [ ] **Step 1: Write the failing test for pure converters and supported list**

`apps/backend/tests/fx-fetcher.test.ts` (initial scaffold; we'll extend in Task 3):

```typescript
import { describe, it, expect } from 'vitest';
import { convertToUsd, listSupportedCurrencies, SUPPORTED_CURRENCIES } from '../src/lib/fx';

describe('fx pure helpers', () => {
  it('listSupportedCurrencies returns USD and CNY', () => {
    expect(listSupportedCurrencies()).toEqual(['USD', 'CNY']);
    expect(SUPPORTED_CURRENCIES).toContain('USD');
    expect(SUPPORTED_CURRENCIES).toContain('CNY');
  });

  it('convertToUsd multiplies amount by rate', () => {
    // CNY 78 at 1/7.2154 ≈ 10.81 USD
    expect(convertToUsd(78, 1 / 7.2154)).toBeCloseTo(10.81, 2);
    // USD passthrough: rate=1
    expect(convertToUsd(123.45, 1)).toBeCloseTo(123.45, 2);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd apps/backend && npx vitest run tests/fx-fetcher.test.ts
```

Expected: FAIL — module `../src/lib/fx` not found.

- [ ] **Step 3: Implement the minimum to pass**

`apps/backend/src/lib/fx.ts`:

```typescript
// Multi-currency vendor bids: ledger-backed FX lookup with a daily
// Frankfurter fetcher and a manager-only manual override.

import type { Sql } from 'postgres';

export const SUPPORTED_CURRENCIES = ['USD', 'CNY'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export interface FxLookup {
  /** Multiplier from quote currency to USD. USD is always 1. */
  rate: number;
  source: 'frankfurter' | 'manual' | 'fixed';
  fetchedAt: Date;
  effectiveDate: string; // ISO YYYY-MM-DD
}

export function listSupportedCurrencies(): readonly SupportedCurrency[] {
  return SUPPORTED_CURRENCIES;
}

export function isSupportedCurrency(c: unknown): c is SupportedCurrency {
  return typeof c === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(c);
}

export function convertToUsd(amount: number, rateToUsd: number): number {
  return Math.round(amount * rateToUsd * 100) / 100;
}

// Real fetch + DB writes added in Task 3.
export async function getLatestRateToUsd(
  _sql: Sql<{}>,
  _quote: SupportedCurrency,
): Promise<FxLookup> {
  throw new Error('not yet implemented');
}

export async function fetchAndStoreLatest(
  _sql: Sql<{}>,
  _quote: SupportedCurrency,
): Promise<FxLookup> {
  throw new Error('not yet implemented');
}

export async function storeManualOverride(
  _sql: Sql<{}>,
  _quote: SupportedCurrency,
  _rate: number,
  _opts: { userId: string; note?: string },
): Promise<FxLookup> {
  throw new Error('not yet implemented');
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd apps/backend && npx vitest run tests/fx-fetcher.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/lib/fx.ts apps/backend/tests/fx-fetcher.test.ts
git commit -m "feat(fx): pure helpers + supported currency list"
```

---

### Task 3: FX module — DB-backed lookup + Frankfurter fetch

**Files:**
- Modify: `apps/backend/src/lib/fx.ts`
- Modify: `apps/backend/tests/fx-fetcher.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Append to `apps/backend/tests/fx-fetcher.test.ts` (keep the pure-helpers `describe` block above):

```typescript
import { afterEach, beforeEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, Dispatcher } from 'undici';
import { getDb } from '../src/db';
import { buildEnv } from '../src/env';
import { resetDb } from './helpers/db';
import {
  fetchAndStoreLatest,
  getLatestRateToUsd,
  storeManualOverride,
} from '../src/lib/fx';

let agent: MockAgent;
let prior: Dispatcher;

beforeEach(async () => {
  await resetDb();
  prior = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(() => {
  setGlobalDispatcher(prior);
});

function mockFrankfurter(rate: number, date = '2026-05-26') {
  agent
    .get('https://api.frankfurter.dev')
    .intercept({ path: '/v1/latest?base=USD&symbols=CNY', method: 'GET' })
    .reply(200, { amount: 1, base: 'USD', date, rates: { CNY: rate } });
}

describe('fx DB-backed lookup', () => {
  it('USD lookup returns 1 / fixed without a DB row', async () => {
    const sql = getDb(buildEnv());
    const r = await getLatestRateToUsd(sql, 'USD');
    expect(r.rate).toBe(1);
    expect(r.source).toBe('fixed');
  });

  it('CNY lookup with no row falls back to live fetch', async () => {
    mockFrankfurter(7.2154);
    const sql = getDb(buildEnv());
    const r = await getLatestRateToUsd(sql, 'CNY');
    // stored multiplier converts CNY -> USD, so 1/7.2154
    expect(r.rate).toBeCloseTo(1 / 7.2154, 6);
    expect(r.source).toBe('frankfurter');
  });

  it('fetchAndStoreLatest inserts a row and is idempotent on same date', async () => {
    mockFrankfurter(7.2154, '2026-05-26');
    const sql = getDb(buildEnv());
    const a = await fetchAndStoreLatest(sql, 'CNY');
    expect(a.effectiveDate).toBe('2026-05-26');

    // Mock again with same date but different rate; should NOT insert a new row.
    mockFrankfurter(7.2999, '2026-05-26');
    const b = await fetchAndStoreLatest(sql, 'CNY');
    expect(b.rate).toBeCloseTo(a.rate, 8);

    const rows = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fx_rates`;
    expect(rows[0].n).toBe(1);
  });

  it('manual override wins over older frankfurter row', async () => {
    mockFrankfurter(7.2154);
    const sql = getDb(buildEnv());
    await fetchAndStoreLatest(sql, 'CNY');

    // Seed a user so created_by FK passes.
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES ('fx@test', 'x', 'manager') RETURNING id
    `;
    await storeManualOverride(sql, 'CNY', 7.0, { userId: u.id, note: 'pinned' });

    const r = await getLatestRateToUsd(sql, 'CNY');
    expect(r.rate).toBeCloseTo(1 / 7.0, 6);
    expect(r.source).toBe('manual');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/backend && npx vitest run tests/fx-fetcher.test.ts
```

Expected: 4 new tests fail with "not yet implemented".

- [ ] **Step 3: Implement the DB-backed body**

Replace the three throwing stubs in `apps/backend/src/lib/fx.ts` with:

```typescript
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest';

export async function getLatestRateToUsd(
  sql: Sql<{}>,
  quote: SupportedCurrency,
): Promise<FxLookup> {
  if (quote === 'USD') {
    return { rate: 1, source: 'fixed', fetchedAt: new Date(), effectiveDate: today() };
  }
  const rows = await sql<FxRow[]>`
    SELECT rate::float AS rate, source, fetched_at, effective_date
    FROM fx_rates
    WHERE base_currency = 'USD' AND quote_currency = ${quote}
    ORDER BY fetched_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return fetchAndStoreLatest(sql, quote);
  const r = rows[0];
  return {
    rate: 1 / r.rate,
    source: r.source as FxLookup['source'],
    fetchedAt: new Date(r.fetched_at),
    effectiveDate: String(r.effective_date).slice(0, 10),
  };
}

export async function fetchAndStoreLatest(
  sql: Sql<{}>,
  quote: SupportedCurrency,
): Promise<FxLookup> {
  if (quote === 'USD') return getLatestRateToUsd(sql, 'USD');
  const url = `${FRANKFURTER_URL}?base=USD&symbols=${quote}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`frankfurter ${res.status}`);
  const body = (await res.json()) as { date: string; rates: Record<string, number> };
  const rate = body.rates[quote];
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('frankfurter: bad rate');
  const date = body.date; // ECB date, YYYY-MM-DD

  // Skip insert when we already have a row for this effective_date.
  const existing = await sql<{ id: string; rate: number }[]>`
    SELECT id, rate::float AS rate FROM fx_rates
    WHERE base_currency = 'USD' AND quote_currency = ${quote}
      AND effective_date = ${date}
    ORDER BY fetched_at DESC LIMIT 1
  `;
  if (existing.length > 0) {
    return {
      rate: 1 / existing[0].rate,
      source: 'frankfurter',
      fetchedAt: new Date(),
      effectiveDate: date,
    };
  }

  await sql`
    INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_date)
    VALUES ('USD', ${quote}, ${rate}, 'frankfurter', ${date})
  `;
  return { rate: 1 / rate, source: 'frankfurter', fetchedAt: new Date(), effectiveDate: date };
}

export async function storeManualOverride(
  sql: Sql<{}>,
  quote: SupportedCurrency,
  rate: number,
  opts: { userId: string; note?: string },
): Promise<FxLookup> {
  if (quote === 'USD') throw new Error('cannot override USD');
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('rate must be > 0');
  const date = today();
  await sql`
    INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_date, note, created_by)
    VALUES ('USD', ${quote}, ${rate}, 'manual', ${date}, ${opts.note ?? null}, ${opts.userId})
  `;
  return { rate: 1 / rate, source: 'manual', fetchedAt: new Date(), effectiveDate: date };
}

interface FxRow { rate: number; source: string; fetched_at: string; effective_date: string }
function today(): string { return new Date().toISOString().slice(0, 10); }
```

Also add the imports needed (`fetch` is a Node 22 global; `undici` is already in scope via dependencies).

- [ ] **Step 4: Run and confirm pass**

```bash
cd apps/backend && npx vitest run tests/fx-fetcher.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/lib/fx.ts apps/backend/tests/fx-fetcher.test.ts
git commit -m "feat(fx): ledger lookup + Frankfurter fetch + manual override"
```

---

### Task 4: Boot-time refresh hook

**Files:**
- Modify: `apps/backend/src/lib/fx.ts`
- Modify: `apps/backend/src/server.ts`

- [ ] **Step 1: Add `startFxRefreshLoop` to `lib/fx.ts`**

Append:

```typescript
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function startFxRefreshLoop(sql: Sql<{}>): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await fetchAndStoreLatest(sql, 'CNY');
    } catch (err) {
      console.warn('[fx] refresh failed; keeping previous row', err);
    }
  };
  // Fire once at boot, then every 6 hours.
  void tick();
  const handle = setInterval(() => void tick(), SIX_HOURS_MS);
  // Don't keep the event loop alive solely for the FX timer.
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
```

- [ ] **Step 2: Wire into `server.ts`**

Modify `apps/backend/src/server.ts:1-16` to add the loop after `buildEnv()`:

```typescript
import '../scripts/load-env.mjs';
import { serve } from '@hono/node-server';
import app from './index';
import { buildEnv } from './env';
import { getDb } from './db';
import { startFxRefreshLoop } from './lib/fx';

const env = buildEnv();
const port = Number(process.env.PORT ?? 8787);

startFxRefreshLoop(getDb(env));

serve({ fetch: (request) => app.fetch(request, env), port }, (info) => {
  console.log(`recycle-erp-backend listening on :${info.port}`);
});
```

- [ ] **Step 3: Verify the suite still passes**

```bash
cd apps/backend && npx vitest run tests/fx-fetcher.test.ts
```

Expected: 6 tests pass. (No new test for the loop — it's a thin wrapper around the already-tested `fetchAndStoreLatest`.)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/lib/fx.ts apps/backend/src/server.ts
git commit -m "feat(fx): boot-time + 6h refresh loop"
```

---

### Task 5: FX routes — manager-only Settings endpoints

**Files:**
- Create: `apps/backend/src/routes/fxRates.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/fx-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/backend/tests/fx-routes.test.ts`:

```typescript
import { beforeEach, describe, it, expect, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, Dispatcher } from 'undici';
import { resetDb } from './helpers/db';
import { loginAs } from './helpers/auth';
import { request } from './helpers/request';

let agent: MockAgent;
let prior: Dispatcher;

beforeEach(async () => {
  await resetDb();
  prior = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(() => setGlobalDispatcher(prior));

function mockFrankfurter(rate: number, date = '2026-05-26') {
  agent
    .get('https://api.frankfurter.dev')
    .intercept({ path: '/v1/latest?base=USD&symbols=CNY', method: 'GET' })
    .reply(200, { amount: 1, base: 'USD', date, rates: { CNY: rate } });
}

describe('fx routes', () => {
  it('GET requires a session', async () => {
    const res = await request('GET', '/api/workspace/fx-rates');
    expect(res.status).toBe(401);
  });

  it('purchaser cannot read', async () => {
    const { headers } = await loginAs('purchaser');
    const res = await request('GET', '/api/workspace/fx-rates', { headers });
    expect(res.status).toBe(403);
  });

  it('manager GET returns latest + history', async () => {
    mockFrankfurter(7.2154);
    const { headers } = await loginAs('manager');
    // Trigger a fetch via refresh endpoint to seed at least one row.
    await request('POST', '/api/workspace/fx-rates/refresh', { headers });
    const res = await request('GET', '/api/workspace/fx-rates', { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latest.CNY.rate).toBeCloseTo(7.2154, 6);
    expect(body.latest.CNY.source).toBe('frankfurter');
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.history.length).toBeGreaterThan(0);
  });

  it('manual override appears as newest row and wins lookup', async () => {
    mockFrankfurter(7.2154);
    const { headers } = await loginAs('manager');
    await request('POST', '/api/workspace/fx-rates/refresh', { headers });

    const res = await request('POST', '/api/workspace/fx-rates', {
      headers,
      body: { quote: 'CNY', rate: 7.0, note: 'pinned for May invoice run' },
    });
    expect(res.status).toBe(201);

    const after = await (await request('GET', '/api/workspace/fx-rates', { headers })).json();
    expect(after.latest.CNY.rate).toBeCloseTo(7.0, 6);
    expect(after.latest.CNY.source).toBe('manual');
  });

  it('manual override rejects unsupported currency', async () => {
    const { headers } = await loginAs('manager');
    const res = await request('POST', '/api/workspace/fx-rates', {
      headers, body: { quote: 'EUR', rate: 1.1 },
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/backend && npx vitest run tests/fx-routes.test.ts
```

Expected: 5 tests fail (404 on the new routes).

- [ ] **Step 3: Implement the router**

`apps/backend/src/routes/fxRates.ts`:

```typescript
import { Hono } from 'hono';
import type { AppCtx } from '../types';
import { getDb } from '../db';
import {
  fetchAndStoreLatest,
  getLatestRateToUsd,
  isSupportedCurrency,
  storeManualOverride,
  SUPPORTED_CURRENCIES,
} from '../lib/fx';

export const fxRates = new Hono<AppCtx>();

fxRates.get('/fx-rates', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);

  const latest: Record<string, { rate: number; source: string; fetchedAt: string; effectiveDate: string }> = {};
  for (const q of SUPPORTED_CURRENCIES) {
    if (q === 'USD') continue;
    const r = await getLatestRateToUsd(sql, q);
    // Re-express as the "USD->quote" rate the UI shows (e.g. 7.2154 not 0.13858).
    latest[q] = {
      rate: 1 / r.rate,
      source: r.source,
      fetchedAt: r.fetchedAt.toISOString(),
      effectiveDate: r.effectiveDate,
    };
  }
  const history = await sql<{
    id: string; quote_currency: string; rate: number; source: string;
    fetched_at: string; effective_date: string; note: string | null;
  }[]>`
    SELECT id, quote_currency, rate::float AS rate, source, fetched_at, effective_date, note
    FROM fx_rates
    ORDER BY fetched_at DESC
    LIMIT 20
  `;
  return c.json({ latest, history });
});

fxRates.post('/fx-rates', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | { quote?: string; rate?: number; note?: string } | null;
  if (!body || !isSupportedCurrency(body.quote) || body.quote === 'USD') {
    return c.json({ error: 'quote must be a supported non-USD currency' }, 400);
  }
  if (!Number.isFinite(body.rate) || (body.rate as number) <= 0) {
    return c.json({ error: 'rate must be > 0' }, 400);
  }
  const r = await storeManualOverride(sql, body.quote, body.rate as number, {
    userId: c.var.user.id, note: body.note,
  });
  return c.json({
    rate: 1 / r.rate, source: r.source, fetchedAt: r.fetchedAt.toISOString(), effectiveDate: r.effectiveDate,
  }, 201);
});

fxRates.post('/fx-rates/refresh', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const r = await fetchAndStoreLatest(sql, 'CNY');
  return c.json({
    rate: 1 / r.rate, source: r.source, fetchedAt: r.fetchedAt.toISOString(), effectiveDate: r.effectiveDate,
  });
});
```

- [ ] **Step 4: Mount the router**

Modify `apps/backend/src/index.ts` to import the new router and add it under the workspace prefix. Find the `workspace` registration (around line 211) and add right after it:

```typescript
import { fxRates as fxRatesRoutes } from './routes/fxRates';
// ...
app.route('/api/workspace', workspaceRoutes);
app.route('/api/workspace', fxRatesRoutes);  // ADD THIS LINE
```

(Both routers register under `/api/workspace`; their path segments don't collide because `fxRates` uses `/fx-rates` and `/fx-rates/refresh`.)

- [ ] **Step 5: Run tests**

```bash
cd apps/backend && npx vitest run tests/fx-routes.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/fxRates.ts apps/backend/src/index.ts apps/backend/tests/fx-routes.test.ts
git commit -m "feat(fx): manager routes GET/POST/refresh /api/workspace/fx-rates"
```

---

### Task 6: Vendor public — accept currency on bid, expose `/fx`

**Files:**
- Modify: `apps/backend/src/routes/vendorPublic.ts`
- Create: `apps/backend/tests/vendor-public-bid-currency.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/backend/tests/vendor-public-bid-currency.test.ts`:

```typescript
import { beforeEach, describe, it, expect, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, Dispatcher } from 'undici';
import { resetDb } from './helpers/db';
import { request } from './helpers/request';
import { seedVendorLinkWithInventory } from './helpers/vendor';
import { getDb } from '../src/db';
import { buildEnv } from '../src/env';

let agent: MockAgent;
let prior: Dispatcher;

beforeEach(async () => {
  await resetDb();
  prior = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  agent.get('https://api.frankfurter.dev')
    .intercept({ path: '/v1/latest?base=USD&symbols=CNY', method: 'GET' })
    .reply(200, { amount: 1, base: 'USD', date: '2026-05-26', rates: { CNY: 7.2154 } })
    .persist();
});
afterEach(() => setGlobalDispatcher(prior));

describe('vendor public bid currency', () => {
  it('defaults to USD when currency omitted (legacy clients)', async () => {
    const { token, inventoryIds } = await seedVendorLinkWithInventory();
    const res = await request('POST', `/api/public/vendor/${token}/bids`, {
      body: {
        contactName: 'Alice',
        lines: [{ inventoryId: inventoryIds[0], qty: 1, unitPrice: 10 }],
      },
    });
    expect(res.status).toBe(201);
    const { bidId } = await res.json();
    const sql = getDb(buildEnv());
    const [row] = await sql<{ currency_code: string; fx_rate_to_usd: number; fx_source: string }[]>`
      SELECT currency_code, fx_rate_to_usd::float AS fx_rate_to_usd, fx_source
      FROM vendor_bids WHERE id = ${bidId}
    `;
    expect(row.currency_code).toBe('USD');
    expect(row.fx_rate_to_usd).toBe(1);
    expect(row.fx_source).toBe('manual');
  });

  it('records currency + frozen rate on a CNY bid', async () => {
    const { token, inventoryIds } = await seedVendorLinkWithInventory();
    const res = await request('POST', `/api/public/vendor/${token}/bids`, {
      body: {
        contactName: 'Bob',
        currency: 'CNY',
        lines: [{ inventoryId: inventoryIds[0], qty: 1, unitPrice: 78 }],
      },
    });
    expect(res.status).toBe(201);
    const sql = getDb(buildEnv());
    const [row] = await sql<{ currency_code: string; fx_rate_to_usd: number; fx_source: string }[]>`
      SELECT currency_code, fx_rate_to_usd::float AS fx_rate_to_usd, fx_source
      FROM vendor_bids ORDER BY created_at DESC LIMIT 1
    `;
    expect(row.currency_code).toBe('CNY');
    expect(row.fx_rate_to_usd).toBeCloseTo(1 / 7.2154, 6);
    expect(row.fx_source).toBe('frankfurter');
  });

  it('rejects an unsupported currency with 400', async () => {
    const { token, inventoryIds } = await seedVendorLinkWithInventory();
    const res = await request('POST', `/api/public/vendor/${token}/bids`, {
      body: {
        contactName: 'Carol', currency: 'EUR',
        lines: [{ inventoryId: inventoryIds[0], qty: 1, unitPrice: 10 }],
      },
    });
    expect(res.status).toBe(400);
  });

  it('GET /fx returns the latest pair', async () => {
    const { token } = await seedVendorLinkWithInventory();
    // Trigger a fetch by hitting the endpoint (which calls getLatestRateToUsd).
    const res = await request('GET', `/api/public/vendor/${token}/fx`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.USD_CNY).toBeCloseTo(7.2154, 6);
    expect(typeof body.fetchedAt).toBe('string');
  });

  it('GET /:token/bids includes currency, fxRateToUsd, fxSource, usdEquivalent', async () => {
    const { token, inventoryIds } = await seedVendorLinkWithInventory();
    await request('POST', `/api/public/vendor/${token}/bids`, {
      body: {
        contactName: 'Dee', currency: 'CNY',
        lines: [{ inventoryId: inventoryIds[0], qty: 10, unitPrice: 78 }],
      },
    });
    const res = await request('GET', `/api/public/vendor/${token}/bids`);
    const { bids } = await res.json();
    const last = bids[0];
    expect(last.currency).toBe('CNY');
    expect(last.fxRateToUsd).toBeCloseTo(1 / 7.2154, 6);
    expect(last.fxSource).toBe('frankfurter');
    // 78 * 10 = 780 CNY ≈ 108.10 USD at 7.2154
    expect(last.usdEquivalent).toBeCloseTo(780 / 7.2154, 1);
  });
});
```

If `apps/backend/tests/helpers/vendor.ts` doesn't already export `seedVendorLinkWithInventory`, add the helper there — it must create a customer, a `vendor_links` row, and at least one `order_lines` row in status `Done` with `qty>=10`, returning `{ token, inventoryIds: string[] }`. Pattern after existing helpers in that folder.

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/backend && npx vitest run tests/vendor-public-bid-currency.test.ts
```

Expected: tests fail (currency/`/fx` not implemented).

- [ ] **Step 3: Extend `vendorPublic.ts`**

Modify the POST handler at `apps/backend/src/routes/vendorPublic.ts:91`. After the existing validation (around line 113), add currency handling, and pass it into the INSERT. Show the diff explicitly:

Replace the body-shape type (~line 96):

```typescript
const body = (await c.req.json().catch(() => null)) as
  | { contactName?: string; note?: string; currency?: string; lines?: BidLineIn[] }
  | null;
```

After the existing line-loop validation (after `for (const l of lines) { … }`, before the throttle), insert:

```typescript
const rawCurrency = (body?.currency ?? 'USD').toUpperCase();
if (!isSupportedCurrency(rawCurrency)) {
  return c.json({ error: 'unsupported currency' }, 400);
}
const currency = rawCurrency as SupportedCurrency;
const fxLookup = await getLatestRateToUsd(sql, currency);
const fxRateToUsd = fxLookup.rate;        // USD passthrough = 1
const fxSource = currency === 'USD' ? 'manual' : fxLookup.source;
```

Add at the top:

```typescript
import { getLatestRateToUsd, isSupportedCurrency, type SupportedCurrency } from '../lib/fx';
```

In the `INSERT INTO vendor_bids` statement around line 162:

```typescript
await tx`
  INSERT INTO vendor_bids
    (id, vendor_link_id, customer_id, contact_name, note,
     currency_code, fx_rate_to_usd, fx_source)
  VALUES
    (${bidId}, ${link.id}, ${link.customer_id}, ${contactName}, ${note},
     ${currency}, ${fxRateToUsd}, ${fxSource})
`;
```

In the GET handler, extend the head query (around line 199) and the response:

```typescript
const bids = await sql<{
  id: string; contact_name: string; note: string | null; status: string;
  created_at: string; currency_code: string; fx_rate_to_usd: number; fx_source: string;
}[]>`
  SELECT id, contact_name, note, status, created_at,
         currency_code, fx_rate_to_usd::float AS fx_rate_to_usd, fx_source
  FROM vendor_bids WHERE vendor_link_id = ${link.id}
  ORDER BY created_at DESC LIMIT 500
`;
```

And in the response mapping (`bids.map`):

```typescript
return c.json({
  bids: bids.map(b => {
    const myLines = lines.filter(l => l.bid_id === b.id);
    const usdEquivalent = myLines.reduce(
      (sum, l) => sum + l.offered_unit_price * l.offered_qty * b.fx_rate_to_usd,
      0,
    );
    return {
      id: b.id, contactName: b.contact_name, note: b.note,
      status: b.status, createdAt: b.created_at,
      currency: b.currency_code,
      fxRateToUsd: b.fx_rate_to_usd,
      fxSource: b.fx_source,
      usdEquivalent: Math.round(usdEquivalent * 100) / 100,
      lines: myLines.map(l => ({
        label: l.label, offeredQty: l.offered_qty, offeredUnitPrice: l.offered_unit_price,
        status: l.line_status, acceptedQty: l.accepted_qty, acceptedUnitPrice: l.accepted_unit_price,
      })),
    };
  }),
});
```

Add the new `GET /:token/fx` endpoint at the bottom of the file:

```typescript
vendorPublic.get('/:token/fx', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);
  const cny = await getLatestRateToUsd(sql, 'CNY');
  return c.json({
    USD_CNY: 1 / cny.rate,
    source: cny.source,
    fetchedAt: cny.fetchedAt.toISOString(),
    effectiveDate: cny.effectiveDate,
  });
});
```

- [ ] **Step 4: Run all touched suites**

```bash
cd apps/backend && npx vitest run tests/vendor-public-bid-currency.test.ts tests/fx-fetcher.test.ts tests/fx-routes.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/vendorPublic.ts apps/backend/tests/vendor-public-bid-currency.test.ts apps/backend/tests/helpers/vendor.ts
git commit -m "feat(vendor): accept currency on bid + GET /fx endpoint"
```

---

### Task 7: Promote handler — re-snapshot rate + write SO line audit cols

**Files:**
- Modify: `apps/backend/src/routes/vendorBids.ts`
- Create: `apps/backend/tests/vendor-bid-promote-fx.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/backend/tests/vendor-bid-promote-fx.test.ts`:

```typescript
import { beforeEach, describe, it, expect, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, Dispatcher } from 'undici';
import { resetDb } from './helpers/db';
import { request } from './helpers/request';
import { loginAs } from './helpers/auth';
import { seedVendorLinkWithInventory } from './helpers/vendor';
import { getDb } from '../src/db';
import { buildEnv } from '../src/env';

let agent: MockAgent;
let prior: Dispatcher;
beforeEach(async () => {
  await resetDb();
  prior = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  agent.get('https://api.frankfurter.dev')
    .intercept({ path: '/v1/latest?base=USD&symbols=CNY', method: 'GET' })
    .reply(200, { amount: 1, base: 'USD', date: '2026-05-26', rates: { CNY: 7.2154 } })
    .persist();
});
afterEach(() => setGlobalDispatcher(prior));

describe('vendor bid promote — fx audit', () => {
  it('CNY bid → SO line has USD unit_price + source audit columns + event detail', async () => {
    const { token, inventoryIds } = await seedVendorLinkWithInventory();
    // Vendor submits CNY bid: 120 × 78 CNY = 9,360 CNY ≈ 1297.21 USD
    const submit = await request('POST', `/api/public/vendor/${token}/bids`, {
      body: {
        contactName: 'Eve', currency: 'CNY',
        lines: [{ inventoryId: inventoryIds[0], qty: 120, unitPrice: 78 }],
      },
    });
    const { bidId } = await submit.json();

    const { headers } = await loginAs('manager');

    // Accept the line at the offered price/qty.
    const decide = await request('POST', `/api/vendor-bids/${bidId}/decide`, {
      headers,
      body: { lines: [{ inventoryId: inventoryIds[0], acceptedQty: 120, acceptedUnitPrice: 78, accept: true }] },
    });
    expect(decide.status).toBe(200);

    const promote = await request('POST', `/api/vendor-bids/${bidId}/promote`, { headers });
    expect(promote.status).toBe(201);
    const { sellOrderId } = await promote.json();

    const sql = getDb(buildEnv());
    const [line] = await sql<{
      unit_price: number; source_currency: string; source_unit_price: number;
      source_fx_rate_to_usd: number;
    }[]>`
      SELECT unit_price::float AS unit_price, source_currency,
             source_unit_price::float AS source_unit_price,
             source_fx_rate_to_usd::float AS source_fx_rate_to_usd
      FROM sell_order_lines WHERE sell_order_id = ${sellOrderId}
    `;
    expect(line.source_currency).toBe('CNY');
    expect(line.source_unit_price).toBeCloseTo(78, 2);
    expect(line.source_fx_rate_to_usd).toBeCloseTo(1 / 7.2154, 6);
    expect(line.unit_price).toBeCloseTo(78 / 7.2154, 2);

    // Event detail records currency + rate + source.
    const [evt] = await sql<{ detail: { source: string; currency?: string; fxRateToUsd?: number; fxSource?: string } }[]>`
      SELECT detail FROM sell_order_events
      WHERE sell_order_id = ${sellOrderId} AND kind = 'created'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(evt.detail.source).toBe('vendor_bid');
    expect(evt.detail.currency).toBe('CNY');
    expect(evt.detail.fxRateToUsd).toBeCloseTo(1 / 7.2154, 6);
    expect(['frankfurter', 'manual']).toContain(evt.detail.fxSource);
  });

  it('USD bid → no source columns populated, unit_price unchanged', async () => {
    const { token, inventoryIds } = await seedVendorLinkWithInventory();
    const submit = await request('POST', `/api/public/vendor/${token}/bids`, {
      body: { contactName: 'Frank', lines: [{ inventoryId: inventoryIds[0], qty: 2, unitPrice: 25 }] },
    });
    const { bidId } = await submit.json();
    const { headers } = await loginAs('manager');
    await request('POST', `/api/vendor-bids/${bidId}/decide`, {
      headers,
      body: { lines: [{ inventoryId: inventoryIds[0], acceptedQty: 2, acceptedUnitPrice: 25, accept: true }] },
    });
    const promote = await request('POST', `/api/vendor-bids/${bidId}/promote`, { headers });
    const { sellOrderId } = await promote.json();
    const sql = getDb(buildEnv());
    const [line] = await sql<{
      unit_price: number; source_currency: string | null; source_unit_price: number | null;
    }[]>`
      SELECT unit_price::float AS unit_price, source_currency,
             source_unit_price::float AS source_unit_price
      FROM sell_order_lines WHERE sell_order_id = ${sellOrderId}
    `;
    expect(line.source_currency).toBeNull();
    expect(line.source_unit_price).toBeNull();
    expect(line.unit_price).toBeCloseTo(25, 2);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/backend && npx vitest run tests/vendor-bid-promote-fx.test.ts
```

Expected: both tests fail (source columns are NULL, event detail missing currency).

- [ ] **Step 3: Extend the promote handler**

Modify `apps/backend/src/routes/vendorBids.ts:151-226`. Top of file, add:

```typescript
import { getLatestRateToUsd, type SupportedCurrency } from '../lib/fx';
```

Inside the promote tx (after the `head` lookup at ~line 163 — extend the head query to include currency, and re-fetch the rate):

```typescript
const head = (await tx<{ customer_id: string; currency_code: SupportedCurrency }[]>`
  SELECT customer_id, currency_code FROM vendor_bids WHERE id=${id} LIMIT 1`)[0];
if (!head) { outcome = { code: 400, msg: 'bid not found' }; return; }

const fx = await getLatestRateToUsd(tx, head.currency_code);
const isNonUsd = head.currency_code !== 'USD';
```

In the per-line INSERT (~line 204), branch on `isNonUsd`:

```typescript
const unitPriceUsd = isNonUsd
  ? Math.round(l.accepted_unit_price * fx.rate * 100) / 100
  : l.accepted_unit_price;
await tx`
  INSERT INTO sell_order_lines
    (sell_order_id, inventory_id, category, label, sub_label, part_number,
     qty, unit_price, warehouse_id, condition, position,
     source_currency, source_unit_price, source_fx_rate_to_usd)
  VALUES
    (${sellId}, ${l.inventory_id}, ${l.category}, ${l.label}, ${l.sub_label},
     ${l.part_number}, ${l.accepted_qty}, ${unitPriceUsd},
     NULL, NULL, ${i},
     ${isNonUsd ? head.currency_code : null},
     ${isNonUsd ? l.accepted_unit_price : null},
     ${isNonUsd ? fx.rate : null})
`;
```

Enrich the event detail (~line 215):

```typescript
await writeSellOrderEvent(tx, sellId, u.id, 'created', {
  source: 'vendor_bid',
  vendorBidId: id,
  status: 'Draft',
  lineCount: lines.length,
  customerId: head.customer_id,
  currency: head.currency_code,
  fxRateToUsd: fx.rate,
  fxSource: fx.source,
  fxEffectiveDate: fx.effectiveDate,
});
```

- [ ] **Step 4: Run tests**

```bash
cd apps/backend && npx vitest run tests/vendor-bid-promote-fx.test.ts tests/vendor-public-bid-currency.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/vendorBids.ts apps/backend/tests/vendor-bid-promote-fx.test.ts
git commit -m "feat(vendor-bids): re-snapshot fx on promote; stamp SO line audit cols"
```

---

### Task 8: Manager bid list/detail responses include currency

**Files:**
- Modify: `apps/backend/src/routes/vendorBids.ts`

- [ ] **Step 1: Extend list/detail GETs**

Locate the manager list endpoint in `vendorBids.ts` (the one feeding `DesktopVendorBids`). Extend the SQL to select `currency_code`, `fx_rate_to_usd`, `fx_source`, and a computed USD total. Then expose them as `currency`, `fxRateToUsd`, `fxSource`, `totalOfferedUsd`.

Example shape for the list query — find the existing one and adapt:

```typescript
const bids = await sql<{
  id: string; customer_id: string; contact_name: string; status: string;
  created_at: string; line_count: number; total_offered: number;
  currency_code: string; fx_rate_to_usd: number; fx_source: string;
  total_offered_usd: number;
}[]>`
  SELECT b.id, b.customer_id, b.contact_name, b.status, b.created_at,
         b.currency_code, b.fx_rate_to_usd::float AS fx_rate_to_usd, b.fx_source,
         COUNT(l.*)::int AS line_count,
         COALESCE(SUM(l.offered_qty * l.offered_unit_price), 0)::float AS total_offered,
         COALESCE(SUM(l.offered_qty * l.offered_unit_price * b.fx_rate_to_usd), 0)::float AS total_offered_usd
  FROM vendor_bids b
  LEFT JOIN vendor_bid_lines l ON l.bid_id = b.id
  GROUP BY b.id
  ORDER BY b.created_at DESC
  LIMIT 500
`;
```

Map into the JSON response with the new fields:

```typescript
return c.json({
  bids: bids.map(b => ({
    id: b.id, customerId: b.customer_id, contactName: b.contact_name,
    status: b.status, createdAt: b.created_at,
    lineCount: b.line_count, totalOffered: b.total_offered,
    currency: b.currency_code, fxRateToUsd: b.fx_rate_to_usd, fxSource: b.fx_source,
    totalOfferedUsd: b.total_offered_usd,
  })),
});
```

Apply the same expansion to the detail endpoint, including a per-line `unitPriceUsd = offered_unit_price * fx_rate_to_usd`. Add the type to the per-line projection.

- [ ] **Step 2: Verify nothing breaks**

```bash
cd apps/backend && npx vitest run
```

Expected: full suite green. (No new test file — these are additive fields covered indirectly by the promote test and the bid-currency test; assert specifically only if a regression sneaks in.)

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/routes/vendorBids.ts
git commit -m "feat(vendor-bids): expose currency + USD-equiv totals on list/detail"
```

---

### Task 9: Frontend — `fmtMoney` helper + i18n keys

**Files:**
- Modify: `apps/frontend/src/lib/format.ts`
- Create: `apps/frontend/src/lib/format.test.ts`
- Modify: `apps/frontend/src/lib/i18n.tsx`

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/lib/format.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { fmtMoney } from './format';

describe('fmtMoney', () => {
  it('formats USD with $ prefix', () => {
    expect(fmtMoney(1234.5, 'USD')).toBe('$1,234.50');
  });
  it('formats CNY with ¥ prefix', () => {
    expect(fmtMoney(78, 'CNY')).toBe('¥78.00');
  });
  it('falls back to ISO code for unknown currency', () => {
    expect(fmtMoney(10, 'XYZ' as 'USD')).toBe('XYZ 10.00');
  });
  it('renders em dash for null', () => {
    expect(fmtMoney(null, 'USD')).toBe('—');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd apps/frontend && npx vitest run src/lib/format.test.ts
```

Expected: `fmtMoney` not exported.

- [ ] **Step 3: Add `fmtMoney`**

Append to `apps/frontend/src/lib/format.ts`:

```typescript
const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', CNY: '¥' };

export const fmtMoney = (
  n: number | null | undefined,
  currency: string,
  locale = 'en-US',
) => {
  if (n == null) return '—';
  const sym = CURRENCY_SYMBOL[currency];
  return sym ? sym + fmt(n, locale) : `${currency} ${fmt(n, locale)}`;
};
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd apps/frontend && npx vitest run src/lib/format.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Add i18n keys**

Open `apps/frontend/src/lib/i18n.tsx` and add to both the English and Chinese dictionaries (locate the existing dictionary objects, follow the surrounding pattern):

```typescript
// English
'currency.label': 'Currency',
'currency.usd': 'USD ($)',
'currency.cny': 'CNY (¥)',
'bid.usd_equivalent': '≈ {usd} at today’s rate ({rate}, {date})',
'bid.in_currency': 'In {currency}',
'fx.title': 'FX rates',
'fx.refresh': 'Refresh now',
'fx.override': 'Override manually…',
'fx.source.frankfurter': 'Frankfurter',
'fx.source.manual': 'manual',
'fx.history': 'History (last 20)',
'fx.pair_usd_cny': 'USD → CNY',
'fx.pair_cny_usd_derived': 'CNY → USD (derived)',
'vb.col.currency': 'Currency',
'vb.col.total_native': 'Total (native)',
'vb.filter.currency_all': 'All',
'vb.detail.fx_badge': '{currency} · {rate} @ {date} ({source})',
'vb.detail.accepted_usd_hint': '≈ {usd} USD',
'vb.detail.promote_with_usd': 'Promote → SO ({usd} USD equivalent)',
```

Mirror the keys in the zh-CN dictionary with Chinese translations (use placeholder strings for now if needed — actual translation can be a follow-up).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/lib/format.ts apps/frontend/src/lib/format.test.ts apps/frontend/src/lib/i18n.tsx
git commit -m "feat(fe): fmtMoney helper + i18n keys for currency/FX"
```

---

### Task 10: Vendor portal — currency picker + live USD-equiv

**Files:**
- Modify: `apps/frontend/src/VendorApp.tsx`

- [ ] **Step 1: Add currency state at the basket level**

In the component that owns the basket (search for `basket` or `lines` state in `VendorApp.tsx`), add:

```tsx
const [currency, setCurrency] = useState<'USD' | 'CNY'>('USD');
const [fxUsdCny, setFxUsdCny] = useState<number | null>(null);
const [fxFetchedAt, setFxFetchedAt] = useState<string | null>(null);

useEffect(() => {
  if (currency === 'USD') return;
  fetch(`/api/public/vendor/${token}/fx`)
    .then(r => r.json())
    .then(j => { setFxUsdCny(j.USD_CNY); setFxFetchedAt(j.fetchedAt); })
    .catch(() => { /* leave null; bid still submittable; backend has its own fallback */ });
}, [currency, token]);
```

- [ ] **Step 2: Render the picker above the basket**

Just above the basket lines:

```tsx
<div className="ph-field" style={{ marginBottom: 12 }}>
  <label>{t('currency.label')}</label>
  <div role="radiogroup" style={{ display: 'flex', gap: 12 }}>
    <label style={{ display: 'flex', gap: 6 }}>
      <input type="radio" name="bid-currency" value="USD"
        checked={currency === 'USD'} onChange={() => setCurrency('USD')} />
      {t('currency.usd')}
    </label>
    <label style={{ display: 'flex', gap: 6 }}>
      <input type="radio" name="bid-currency" value="CNY"
        checked={currency === 'CNY'} onChange={() => setCurrency('CNY')} />
      {t('currency.cny')}
    </label>
  </div>
</div>
```

- [ ] **Step 3: Swap the price-input symbol in `OfferEditor`**

`VendorApp.tsx:408-445` — pass `currency` down as a prop, and change the input's `placeholder` and the small adornment label:

```tsx
function OfferEditor({ it, t, existing, currency, onSave, onRemove }: {
  it: CatalogItem; existing: BasketLine | undefined; t: T;
  currency: 'USD' | 'CNY';
  onSave: (qty: number, price: number) => void; onRemove: () => void;
}) {
  // ...
  <input type="number" min={0} step="0.01" value={price} className="input"
    placeholder={currency === 'USD' ? '$' : '¥'}
    style={{ borderColor: 'var(--accent)' }}
    onChange={e => setPrice(e.target.value)} />
```

- [ ] **Step 4: Subtotal line with live USD equiv**

Just above the submit button:

```tsx
<div style={{ marginTop: 12 }}>
  <div style={{ fontWeight: 600 }}>
    {t('bid.in_currency').replace('{currency}', currency)}:{' '}
    {fmtMoney(subtotal, currency)}
  </div>
  {currency === 'CNY' && fxUsdCny && (
    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
      {t('bid.usd_equivalent')
        .replace('{usd}', fmtMoney(subtotal / fxUsdCny, 'USD'))
        .replace('{rate}', fxUsdCny.toFixed(4))
        .replace('{date}', new Date(fxFetchedAt ?? Date.now()).toISOString().slice(0, 10))}
    </div>
  )}
</div>
```

`subtotal` is `lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)`.

- [ ] **Step 5: Send `currency` on submit**

Find the `apiFetch` (or raw `fetch`) call that POSTs the bid. Add `currency` to the body:

```tsx
body: JSON.stringify({
  contactName, note,
  currency,
  lines: basket.map(l => ({ inventoryId: l.inventoryId, qty: l.qty, unitPrice: l.unitPrice })),
}),
```

- [ ] **Step 6: Manual smoke test**

```bash
pnpm dev
```

Visit a vendor link (`/v/<token>`), pick CNY, add an item, verify the subtotal line shows `≈ $X.XX at today's rate (…)`, submit, and verify in psql:

```sql
SELECT id, currency_code, fx_rate_to_usd, fx_source FROM vendor_bids ORDER BY created_at DESC LIMIT 1;
```

Expected: most recent row has `currency_code='CNY'` and a non-1 rate.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/VendorApp.tsx
git commit -m "feat(fe): vendor portal currency picker + live USD-equiv subtotal"
```

---

### Task 11: Staff bid list — Currency column + USD-equiv totals + filter

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx`

- [ ] **Step 1: Extend types and fetch**

Find the type that mirrors the bid list row (search `interface Bid` or similar near the top). Add:

```typescript
currency: 'USD' | 'CNY';
fxRateToUsd: number;
fxSource: 'frankfurter' | 'manual' | 'fixed';
totalOfferedUsd: number;
```

The `apiFetch('/api/vendor-bids')` call already exists; no change beyond consuming the new fields.

- [ ] **Step 2: Add the Currency column**

Modify the table header at `DesktopVendorBids.tsx:160-168`:

```tsx
<thead>
  <tr>
    <th>{t('vbColCustomer')}</th>
    <th>{t('vbColContact')}</th>
    <th>{t('vb.col.currency')}</th>
    <th className="num">{t('vbColLines')}</th>
    <th className="num">{t('vbColOffered')}</th>
    <th>{t('vbColSubmitted')}</th>
    <th>{t('vbColStatus')}</th>
  </tr>
</thead>
```

Add the matching `<td>` in the body row. For the *Offered* (totals) cell, show USD on the primary line and native total as a smaller grey second line for non-USD bids:

```tsx
<td>{b.currency}</td>
{/* ... */}
<td className="num">
  {fmtUSD(b.totalOfferedUsd)}
  {b.currency !== 'USD' && (
    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
      {fmtMoney(b.totalOffered, b.currency)}
    </div>
  )}
</td>
```

- [ ] **Step 3: Add the filter chip**

Above the table, alongside any existing filter UI:

```tsx
const [currencyFilter, setCurrencyFilter] = useState<'All' | 'USD' | 'CNY'>('All');

// in JSX
<select value={currencyFilter} onChange={e => setCurrencyFilter(e.target.value as 'All' | 'USD' | 'CNY')}>
  <option value="All">{t('vb.filter.currency_all')}</option>
  <option value="USD">USD</option>
  <option value="CNY">CNY</option>
</select>
```

Apply it in the rendered rows:

```tsx
{bids
  .filter(b => currencyFilter === 'All' || b.currency === currencyFilter)
  .map(b => /* row JSX */)}
```

- [ ] **Step 4: Smoke test**

```bash
pnpm dev
```

Visit `/vendor-bids`. Confirm:
- Currency column appears for all rows
- A CNY bid shows USD-equiv as the bold figure with native total beneath
- Filter dropdown narrows rows correctly

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopVendorBids.tsx
git commit -m "feat(fe): vendor-bids list shows Currency, USD-equiv totals, filter"
```

---

### Task 12: Staff bid detail modal — FX badge, USD-equiv column, hints, promote label

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx`

- [ ] **Step 1: Render the FX badge in the modal header**

Find the modal header. After the customer/contact/status info, render:

```tsx
{bid.currency !== 'USD' && (
  <div className="ph-badge" style={{ background: 'var(--bg-soft)', padding: '2px 8px' }}>
    {t('vb.detail.fx_badge')
      .replace('{currency}', bid.currency)
      .replace('{rate}', (1 / bid.fxRateToUsd).toFixed(4))
      .replace('{date}', bid.createdAt.slice(0, 10))
      .replace('{source}', bid.fxSource)}
  </div>
)}
```

- [ ] **Step 2: Add a USD-equiv column to the lines table**

In the line table near `DesktopVendorBids.tsx:488-499`, add a read-only USD-equiv column right after the offered-unit column. Per-line type already has `unitPriceUsd` from Task 8.

```tsx
<td className="num">{fmtMoney(l.offeredUnitPrice, bid.currency)}</td>
<td className="num" style={{ color: 'var(--muted)' }}>
  {bid.currency === 'USD' ? '' : fmtUSD(l.unitPriceUsd)}
</td>
```

- [ ] **Step 3: Show the accepted-USD hint**

Below the accepted-unit input at lines 488-499, render an inline hint when currency is non-USD:

```tsx
<td className="num">
  <input className="so-mini-input" type="number" step="0.01" min={0}
    value={d.acceptedUnitPrice}
    disabled={!accepted || promoted}
    onChange={e => setLine(l.id, { acceptedUnitPrice: Math.max(0, Number(e.target.value) || 0) })}
    style={{ width: 90 }} />
  {bid.currency !== 'USD' && d.acceptedUnitPrice > 0 && (
    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
      {t('vb.detail.accepted_usd_hint')
        .replace('{usd}', fmtUSD(d.acceptedUnitPrice * bid.fxRateToUsd))}
    </div>
  )}
</td>
```

- [ ] **Step 4: Promote button label**

Find the Promote button in this same file. Change its label to include USD equivalent when the bid is non-USD:

```tsx
<button className="ph-btn accent" disabled={!canPromote} onClick={onPromote}>
  {bid.currency === 'USD'
    ? t('vbPromote')
    : t('vb.detail.promote_with_usd').replace('{usd}', fmtUSD(promoteTotalUsd))}
</button>
```

Where `promoteTotalUsd = lines.filter(l => l.lineStatus === 'accepted').reduce((s, l) => s + l.acceptedUnitPrice * l.acceptedQty * bid.fxRateToUsd, 0)`.

- [ ] **Step 5: Smoke test**

```bash
pnpm dev
```

Open a CNY bid in the detail modal. Verify:
- FX badge appears in header (e.g. `CNY · 7.2154 @ 2026-05-22 (frankfurter)`)
- USD-equiv column shows per-line conversion
- Accepted-price hint shows under the input
- Promote button reads `Promote → SO ($X,XXX USD equivalent)`

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopVendorBids.tsx
git commit -m "feat(fe): vendor-bid detail modal FX badge, USD-equiv col, promote label"
```

---

### Task 13: Workspace Settings → FX panel

**Files:**
- Create: `apps/frontend/src/components/FxRatesPanel.tsx`
- Modify: the page that hosts workspace settings (locate via `grep -r "workspace_settings\|Workspace settings\|fx_auto" apps/frontend/src` — likely `apps/frontend/src/pages/desktop/DesktopWorkspace.tsx` or similar)

- [ ] **Step 1: Build the panel**

`apps/frontend/src/components/FxRatesPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtDate } from '../lib/format';

interface LatestRow { rate: number; source: string; fetchedAt: string; effectiveDate: string }
interface HistoryRow {
  id: string; quote_currency: string; rate: number; source: string;
  fetched_at: string; note: string | null;
}

export function FxRatesPanel() {
  const { t } = useT();
  const [latest, setLatest] = useState<Record<string, LatestRow>>({});
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideRate, setOverrideRate] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await apiFetch<{ latest: Record<string, LatestRow>; history: HistoryRow[] }>(
      'GET', '/api/workspace/fx-rates',
    );
    setLatest(r.latest);
    setHistory(r.history);
  }

  useEffect(() => { void load(); }, []);

  async function refresh() {
    setBusy(true);
    try {
      await apiFetch('POST', '/api/workspace/fx-rates/refresh');
      await load();
    } finally { setBusy(false); }
  }

  async function submitOverride(e: React.FormEvent) {
    e.preventDefault();
    const rate = Number(overrideRate);
    if (!Number.isFinite(rate) || rate <= 0) return;
    setBusy(true);
    try {
      await apiFetch('POST', '/api/workspace/fx-rates', { quote: 'CNY', rate, note: overrideNote || undefined });
      setOverrideOpen(false);
      setOverrideRate('');
      setOverrideNote('');
      await load();
    } finally { setBusy(false); }
  }

  const cny = latest.CNY;

  return (
    <section style={{ marginTop: 24 }}>
      <h2>{t('fx.title')}</h2>
      <table className="ph-table" style={{ maxWidth: 520 }}>
        <thead>
          <tr><th>Pair</th><th className="num">Rate</th><th>Source</th><th>Updated</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>{t('fx.pair_usd_cny')}</td>
            <td className="num">{cny ? cny.rate.toFixed(4) : '—'}</td>
            <td>{cny ? t(`fx.source.${cny.source}` as const) : '—'}</td>
            <td>{cny ? fmtDate(cny.fetchedAt) : '—'}</td>
          </tr>
          <tr style={{ color: 'var(--muted)' }}>
            <td>{t('fx.pair_cny_usd_derived')}</td>
            <td className="num">{cny ? (1 / cny.rate).toFixed(5) : '—'}</td>
            <td>(derived)</td>
            <td></td>
          </tr>
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="ph-btn" disabled={busy} onClick={refresh}>{t('fx.refresh')}</button>
        <button className="ph-btn ghost" disabled={busy} onClick={() => setOverrideOpen(true)}>
          {t('fx.override')}
        </button>
      </div>

      {overrideOpen && (
        <form onSubmit={submitOverride} style={{ marginTop: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 8, maxWidth: 420 }}>
          <div className="ph-field">
            <label>USD → CNY rate</label>
            <input className="input" type="number" step="0.0001" min={0} required
              value={overrideRate} onChange={e => setOverrideRate(e.target.value)} />
          </div>
          <div className="ph-field">
            <label>Note (optional)</label>
            <input className="input" maxLength={200}
              value={overrideNote} onChange={e => setOverrideNote(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="ph-btn accent" disabled={busy}>Save</button>
            <button type="button" className="ph-btn ghost" onClick={() => setOverrideOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      <h3 style={{ marginTop: 24 }}>{t('fx.history')}</h3>
      <table className="ph-table" style={{ maxWidth: 720 }}>
        <thead>
          <tr><th>When</th><th className="num">Rate</th><th>Source</th><th>Note</th></tr>
        </thead>
        <tbody>
          {history.map(h => (
            <tr key={h.id}>
              <td>{fmtDate(h.fetched_at)}</td>
              <td className="num">{h.rate.toFixed(4)}</td>
              <td>{h.source}</td>
              <td>{h.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 2: Embed the panel**

In the workspace settings page, import and render:

```tsx
import { FxRatesPanel } from '../../components/FxRatesPanel';
// ...
{currentUser.role === 'manager' && <FxRatesPanel />}
```

- [ ] **Step 3: Smoke test**

```bash
pnpm dev
```

Log in as a manager. Navigate to Workspace settings. Verify the FX panel renders the current rate, Refresh actually refreshes, manual override saves and appears in history, and a purchaser session does not show the panel.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/components/FxRatesPanel.tsx apps/frontend/src/pages/desktop/DesktopWorkspace.tsx
git commit -m "feat(fe): FX rates settings panel (manager-only)"
```

---

### Task 14: SO history label — mention source currency

**Files:**
- Modify: the React component that renders SO `promoted_from_bid` events (locate via `grep -r "promoted_from_bid\|source.*vendor_bid" apps/frontend/src` — likely `apps/frontend/src/components/SellOrderHistory.tsx`)

- [ ] **Step 1: Extend the event renderer**

Where the `promoted_from_bid` (or the `created` event with `source: 'vendor_bid'`) label is built, branch on `detail.currency`:

```tsx
if (e.kind === 'created' && e.detail?.source === 'vendor_bid') {
  const cur = e.detail.currency as 'USD' | 'CNY' | undefined;
  const rate = e.detail.fxRateToUsd as number | undefined;
  const src = e.detail.fxSource as string | undefined;
  return cur && cur !== 'USD' && rate
    ? `Promoted from bid ${e.detail.vendorBidId} — ${cur} at fx ${(1 / rate).toFixed(4)} (${src})`
    : `Promoted from bid ${e.detail.vendorBidId}`;
}
```

- [ ] **Step 2: Smoke test**

In the dev UI, open a sell order that was promoted from a CNY bid. Open the History tab. Verify the row reads `Promoted from bid VB-XXXX — CNY at fx 7.2154 (frankfurter)`.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/components/SellOrderHistory.tsx
git commit -m "feat(fe): SO history shows source currency for vendor-bid promotions"
```

---

### Task 15: Full-suite verification + manual end-to-end walkthrough

**Files:** none

- [ ] **Step 1: Backend full suite**

```bash
cd apps/backend && npx vitest run
```

Expected: all green (or the known harness flakiness flagged in CLAUDE.md, which is unrelated to this work).

- [ ] **Step 2: Frontend tests**

```bash
cd apps/frontend && pnpm test
```

Expected: green.

- [ ] **Step 3: Typecheck the workspace**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Manual walkthrough (golden path)**

```bash
pnpm dev
```

1. As a manager, open Workspace Settings → FX rates. Click *Refresh now*. Confirm the rate updates.
2. Click *Override manually…*; set rate to 7.0000 with note "test pin". Save. Confirm history shows manual entry on top and "Pair" rate is 7.0.
3. Open a vendor link in another browser tab. Pick CNY. Add a line at qty 10, unit 78. Confirm the subtotal shows `≈ $111.43 at today's rate (7.0000, …)`. Submit.
4. Back as manager, open `/vendor-bids`. The new bid has Currency=CNY and Total shows `$111.43` with `CNY 780.00` beneath.
5. Open the bid detail modal. Confirm the FX badge, USD-equiv column, and accepted-USD hint.
6. Set acceptedQty=10 and acceptedUnitPrice=78. Click *Promote → SO ($111.43 USD equivalent)*.
7. Navigate to the resulting SO. Open History. Confirm `Promoted from bid VB-XXXX — CNY at fx 7.0000 (manual)`.
8. In psql, confirm:

   ```sql
   SELECT unit_price, source_currency, source_unit_price, source_fx_rate_to_usd
   FROM sell_order_lines
   WHERE sell_order_id = '<SO-id>';
   ```

   Expected: `unit_price ≈ 11.14`, `source_currency='CNY'`, `source_unit_price=78.00`, `source_fx_rate_to_usd ≈ 0.142857`.

- [ ] **Step 5: Reset the manual override**

If wanted, insert a fresh Frankfurter row (`Refresh now`) so production-like rate is current.

- [ ] **Step 6: Final commit (if anything tweaked)**

```bash
git status
# If clean, nothing to commit. Otherwise:
git add -A
git commit -m "chore(fx): final cleanup after E2E"
```

- [ ] **Step 7: Push**

```bash
git push origin main
```

---

## Self-review notes

- Spec coverage: every spec section maps to a task — schema (1), FX module (2-4), backend routes (5-8), formatters/i18n (9), vendor portal (10), staff list (11), staff detail (12), settings panel (13), SO history (14), verification (15). ✓
- Placeholder scan: every code step contains the actual code, every command its expected output. ✓
- Type consistency: `SupportedCurrency`, `FxLookup`, `fmtMoney`, `fxRateToUsd` (multiplier-to-USD), `source_currency`/`source_unit_price`/`source_fx_rate_to_usd` (audit cols) are used identically across all tasks. ✓
- One ambiguity worth a heads-up at execution: the seeding helper `seedVendorLinkWithInventory` in Task 6 may already exist under a different name in `apps/backend/tests/helpers/vendor.ts` — implementer should reuse if so, else add. The plan specifies the contract.
