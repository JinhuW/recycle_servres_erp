# Sell-Order Market Data Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a sell order transitions to `Done`, record one qty-weighted-average price data point per sold product on the Market Value board.

**Architecture:** Inside the existing `POST /api/sell-orders/:id/status` Done transaction, a new helper `recordSaleDataPoints` loads the order's lines, groups them by canonical part number, ensures each product has a `ref_prices` row (via the existing `autoTrackParts`), and appends a `ref_price_events` data point per product (via the existing `appendPriceEvent`). No schema change; scraper aggregates are left untouched.

**Tech Stack:** Node 24, Hono, postgres.js (`sql.begin` transactions), Vitest integration tests against real Postgres.

## Global Constraints

- **pnpm only.** Never introduce `package-lock.json`/`yarn.lock`.
- **TypeScript only**, Google TypeScript Style Guide. Comments explain *why*, not *what*.
- **One shared pool:** call `getDb(env)` / use the passed `tx`; never new-up `postgres()`.
- **Atomic writes inside `sql.begin`**; pass `tx` down, never a fresh `sql`.
- **No new migration** — reuses `ref_prices` / `ref_price_events`.
- **Recorded price is USD.** `sell_order_lines.unit_price` is already USD (migration `0065`); do not convert it and do not read `source_unit_price`.
- **Canonical part number rule** (single source of truth in `apps/backend/src/lib/part-number.ts`): strip a leading `P/N`|`S/N`|`PART(NO|NUMBER)?` prefix, drop ALL whitespace, upper-case.
- Run a single backend test file with: `cd apps/backend && npx vitest run tests/<file>.test.ts` (the `pnpm --filter … -- <path>` form silently runs the whole suite).

---

### Task 1: JS canonical-part-number helper

A JS-side canonicaliser is needed to group sell-order lines by product before the SQL round-trip. The canonical rule already lives in `part-number.ts` (SQL fragments only); add the JS twin there so both stay in one file.

**Files:**
- Modify: `apps/backend/src/lib/part-number.ts`
- Test: `apps/backend/tests/part-number-canon.test.ts` (create)

**Interfaces:**
- Produces: `canonPartNumberJs(pn: string): string`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/part-number-canon.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { canonPartNumberJs } from '../src/lib/part-number';

describe('canonPartNumberJs', () => {
  it('strips a P/N prefix, drops whitespace, upper-cases', () => {
    expect(canonPartNumberJs('P/N: hma 84gr7 afr4n-uh')).toBe('HMA84GR7AFR4NUH');
  });
  it('strips an S/N prefix', () => {
    expect(canonPartNumberJs('S/N abc-123')).toBe('ABC-123');
  });
  it('treats spacing/case variants of the same PN as equal', () => {
    expect(canonPartNumberJs('  m393a2k43bb1-ctd ')).toBe(canonPartNumberJs('M393A2K43BB1-CTD'));
  });
  it('leaves a bare part number untouched except case', () => {
    expect(canonPartNumberJs('720-ct')).toBe('720-CT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/part-number-canon.test.ts`
Expected: FAIL — `canonPartNumberJs` is not exported.

- [ ] **Step 3: Add the helper**

Append to `apps/backend/src/lib/part-number.ts` (after `canonPartArg`):

```typescript
// JS twin of the SQL canonicaliser above, for grouping rows in application
// code before a DB round-trip. Keep in lockstep with PART_PREFIX_RE.
export function canonPartNumberJs(pn: string): string {
  return pn
    .replace(/^\s*(?:P\s*\/?\s*N|S\s*\/?\s*N|PART\s*(?:NO|NUMBER)?)\s*[:#]?\s*/i, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/part-number-canon.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/lib/part-number.ts apps/backend/tests/part-number-canon.test.ts
git commit -m "feat: add canonPartNumberJs helper"
```

---

### Task 2: Optional label/subLabel on `autoTrackParts`

`sell_order_lines` carries a real `label`/`sub_label` but none of the spec fields. Without passing them, an auto-created `ref_prices` row falls back to a label equal to the bare part number. Add optional `label`/`subLabel` so the sale path can seed a readable row. The PO-intake caller passes neither and is unchanged.

**Files:**
- Modify: `apps/backend/src/lib/marketAutoTrack.ts`
- Test: `apps/backend/tests/market-auto-track-label.test.ts` (create)

**Interfaces:**
- Consumes: `canonPartNumberJs` — not used here (kept in Task 3).
- Produces: `TrackablePart` gains `label?: string | null` and `subLabel?: string | null`; `autoTrackParts(tx, parts)` inserts them when present.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/market-auto-track-label.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { autoTrackParts } from '../src/lib/marketAutoTrack';

// autoTrackParts is called inside a caller's tx in production. Calling it with
// the plain pool here (autocommit per statement) is fine for asserting the row
// it writes.
describe('autoTrackParts — optional label/subLabel', () => {
  beforeEach(async () => { await resetDb(); });

  it('uses the supplied label and sub_label on the inserted row', async () => {
    const sql = getTestDb();
    const pn = 'LABELTEST-001';
    const out = await autoTrackParts(sql, [{
      category: 'RAM', partNumber: pn, label: 'Samsung 32GB DDR4', subLabel: 'RDIMM 3200',
    }]);
    expect(out.inserted).toBe(1);

    const row = (await sql<{ label: string; sub_label: string | null }[]>`
      SELECT label, sub_label FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    expect(row.label).toBe('Samsung 32GB DDR4');
    expect(row.sub_label).toBe('RDIMM 3200');
  });

  it('falls back to the part number when no label is given', async () => {
    const sql = getTestDb();
    const pn = 'LABELTEST-002';
    await autoTrackParts(sql, [{ category: 'RAM', partNumber: pn }]);
    const row = (await sql<{ label: string; sub_label: string | null }[]>`
      SELECT label, sub_label FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    expect(row.label).toBe(pn);
    expect(row.sub_label).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/market-auto-track-label.test.ts`
Expected: FAIL — first test gets `label` = `'LABELTEST-001'` (synthLabel fallback) and `sub_label` = null, because the columns aren't wired yet.

- [ ] **Step 3: Extend `TrackablePart`**

In `apps/backend/src/lib/marketAutoTrack.ts`, add two fields to the `TrackablePart` type (after `description`):

```typescript
  description?: string | null;
  label?: string | null;
  subLabel?: string | null;
  health?: number | null;
```

- [ ] **Step 4: Wire label/sub_label into the INSERT**

In `autoTrackParts`, replace the INSERT statement (the one inside the `for (const [canon, { raw, part }] of byCanon)` loop) with:

```typescript
    await tx`
      INSERT INTO ref_prices (
        id, category, brand, capacity, type, classification, rank, speed,
        interface, form_factor, description, part_number,
        label, sub_label, samples, source, updated_at, health, rpm
      ) VALUES (
        gen_random_uuid()::text, ${part.category},
        ${part.brand ?? null}, ${part.capacity ?? null}, ${part.type ?? null},
        ${part.classification ?? null}, ${part.rank ?? null}, ${part.speed ?? null},
        ${part.interface ?? null}, ${part.formFactor ?? null}, ${part.description ?? null},
        ${raw}, ${(part.label ?? '').trim() || synthLabel(part, raw)}, ${part.subLabel ?? null},
        0, 'auto-intake', NOW(),
        ${part.health ?? null}, ${part.rpm ?? null}
      )
    `;
```

(Only `label`'s value expression and the new `sub_label` column are added; every other column is unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/backend && npx vitest run tests/market-auto-track-label.test.ts tests/market-auto-track.test.ts`
Expected: PASS — the new file (2 tests) and the existing auto-track suite still green.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/lib/marketAutoTrack.ts apps/backend/tests/market-auto-track-label.test.ts
git commit -m "feat: autoTrackParts accepts optional label/subLabel"
```

---

### Task 3: Record data points on Done

Create the `recordSaleDataPoints` helper and call it from the sell-order Done transition. The helper groups the order's lines by canonical PN, computes the qty-weighted average USD `unit_price` per product, ensures a `ref_prices` row exists, and appends one data point per product. Test end-to-end through the status API.

**Files:**
- Create: `apps/backend/src/lib/sellOrderMarket.ts`
- Modify: `apps/backend/src/routes/sellOrders.ts` (import + one call inside the `if (body.to === 'Done')` block)
- Test: `apps/backend/tests/sell-order-market-datapoint.test.ts` (create)

**Interfaces:**
- Consumes: `canonPartNumberJs` (Task 1); `autoTrackParts` with `label`/`subLabel` (Task 2); `appendPriceEvent` (`apps/backend/src/lib/refPriceEvents.ts`); `PART_PREFIX_RE` (`apps/backend/src/lib/part-number.ts`).
- Produces: `recordSaleDataPoints(tx: TransactionSql, sellOrderId: string, actorUserId: string): Promise<{ recorded: number }>`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/sell-order-market-datapoint.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { CLOSE_REASON_IDS } from '@recycle-erp/shared';

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

async function toDone(token: string, sellOrderId: string) {
  return api('POST', `/api/sell-orders/${sellOrderId}/status`, {
    token, body: { to: 'Done' },
  });
}

// The market board is USD; a completed sale should leave one data point per
// sold product. See docs/superpowers/specs/2026-07-05-sell-order-market-datapoint-design.md
describe('sell order Done → market data point', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('records last_price + one event for a sold part (auto-creating the row)', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const pn = 'SALE-DP-NEW-001';

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM',
        label: 'Sold RAM', subLabel: 'RDIMM', partNumber: pn, qty: 1, unitPrice: 55 }] },
    });
    expect(create.status).toBe(201);
    expect((await toDone(token, create.body.id)).status).toBe(200);

    const sql = getTestDb();
    const rp = (await sql<{ id: string; last_price: number; last_price_source: string;
      samples: number; label: string }[]>`
      SELECT id, last_price::float AS last_price, last_price_source, samples, label
      FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    expect(rp.last_price).toBe(55);
    expect(rp.last_price_source).toBe(`sale:${create.body.id}`);
    expect(rp.label).toBe('Sold RAM');
    expect(rp.samples).toBe(0); // aggregate untouched by a sale

    const events = await sql<{ price: number; source: string }[]>`
      SELECT price::float AS price, source FROM ref_price_events WHERE ref_price_id = ${rp.id}
    `;
    expect(events).toHaveLength(1);
    expect(events[0].price).toBe(55);
  });

  it('rolls up same-PN lines into one qty-weighted data point', async () => {
    const { token } = await loginAs(ALEX);
    const a = await freeSellableLine(token, 1);
    const b = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const pn = 'SALE-DP-ROLLUP-001';

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [
        { inventoryId: a.id, category: 'RAM', label: 'x', partNumber: pn, qty: 2, unitPrice: 100 },
        { inventoryId: b.id, category: 'RAM', label: 'x', partNumber: pn, qty: 3, unitPrice: 50 },
      ] },
    });
    expect(create.status).toBe(201);
    expect((await toDone(token, create.body.id)).status).toBe(200);

    const sql = getTestDb();
    const rp = (await sql<{ id: string; last_price: number }[]>`
      SELECT id, last_price::float AS last_price FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    // (2·100 + 3·50) / (2+3) = 350/5 = 70
    expect(rp.last_price).toBe(70);
    const events = await sql<{ price: number }[]>`
      SELECT price::float AS price FROM ref_price_events WHERE ref_price_id = ${rp.id}
    `;
    expect(events).toHaveLength(1);
    expect(events[0].price).toBe(70);
  });

  it('skips lines with no part number', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const sql = getTestDb();
    const before = (await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM ref_price_events`)[0].c;

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM',
        label: 'no-pn', qty: 1, unitPrice: 40 }] },
    });
    expect(create.status).toBe(201);
    expect((await toDone(token, create.body.id)).status).toBe(200);

    const after = (await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM ref_price_events`)[0].c;
    expect(after).toBe(before);
  });

  it('records the USD unit_price for a CNY order, not the native price', async () => {
    // Frankfurter mock: 1 CNY = 0.14 USD.
    const RATE = 0.14;
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ rates: { USD: RATE } }), { status: 200 })));
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const pn = 'SALE-DP-CNY-001';

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, currency: 'CNY', lines: [{ inventoryId: line.id, category: 'RAM',
        label: 'x', partNumber: pn, qty: 1, unitPrice: 100 }] },
    });
    expect(create.status).toBe(201);
    expect((await toDone(token, create.body.id)).status).toBe(200);

    const sql = getTestDb();
    const rp = (await sql<{ last_price: number }[]>`
      SELECT last_price::float AS last_price FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    // Stored unit_price is USD: 100 CNY × 0.14 = 14.00.
    expect(rp.last_price).toBeCloseTo(14, 2);
  });

  it('does not record a data point when the order is Closed', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const pn = 'SALE-DP-CLOSED-001';

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM',
        label: 'x', partNumber: pn, qty: 1, unitPrice: 33 }] },
    });
    expect(create.status).toBe(201);
    const closed = await api('POST', `/api/sell-orders/${create.body.id}/status`, {
      token, body: { to: 'Closed', closeReasonId: CLOSE_REASON_IDS[0] },
    });
    expect(closed.status).toBe(200);

    const sql = getTestDb();
    const rows = await sql<{ id: string }[]>`SELECT id FROM ref_prices WHERE part_number = ${pn}`;
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/sell-order-market-datapoint.test.ts`
Expected: FAIL — no data points recorded (Done doesn't call the helper yet).

- [ ] **Step 3: Create the helper**

Create `apps/backend/src/lib/sellOrderMarket.ts`:

```typescript
import type { TransactionSql } from 'postgres';
import { PART_PREFIX_RE, canonPartNumberJs } from './part-number';
import { autoTrackParts, type TrackablePart } from './marketAutoTrack';
import { appendPriceEvent } from './refPriceEvents';

type LineRow = {
  part_number: string | null;
  unit_price: number;
  qty: number;
  category: string;
  label: string;
  sub_label: string | null;
};

type Group = {
  raw: string;
  category: string;
  label: string;
  subLabel: string | null;
  priceQty: number; // Σ unit_price·qty
  qty: number;      // Σ qty
};

// On sell-order completion, append one market data point per distinct sold
// product (canonical part number). Price is the qty-weighted average of the
// line unit_price, which is already USD (see migration 0065). Runs inside the
// caller's Done tx so it commits with the sale or not at all.
export async function recordSaleDataPoints(
  tx: TransactionSql,
  sellOrderId: string,
  actorUserId: string,
): Promise<{ recorded: number }> {
  const lines = await tx<LineRow[]>`
    SELECT part_number, unit_price::float AS unit_price, qty, category, label, sub_label
    FROM sell_order_lines
    WHERE sell_order_id = ${sellOrderId}
  `;

  const byCanon = new Map<string, Group>();
  for (const l of lines) {
    const raw = (l.part_number ?? '').trim();
    if (!raw) continue;
    const canon = canonPartNumberJs(raw);
    if (!canon) continue;
    const g = byCanon.get(canon);
    if (g) {
      g.priceQty += l.unit_price * l.qty;
      g.qty += l.qty;
    } else {
      byCanon.set(canon, {
        raw, category: l.category, label: l.label, subLabel: l.sub_label,
        priceQty: l.unit_price * l.qty, qty: l.qty,
      });
    }
  }
  if (byCanon.size === 0) return { recorded: 0 };

  // Ensure a ref_prices row exists for every sold product.
  const parts: TrackablePart[] = Array.from(byCanon.values()).map(g => ({
    category: g.category, partNumber: g.raw, label: g.label, subLabel: g.subLabel,
  }));
  await autoTrackParts(tx, parts);

  // Map each canonical PN back to its ref_prices id.
  const canons = Array.from(byCanon.keys());
  const idRows = await tx<{ id: string; canon: string }[]>`
    SELECT id,
           UPPER(REGEXP_REPLACE(
             REGEXP_REPLACE(COALESCE(part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
             '[[:space:]]+', '', 'g'
           )) AS canon
    FROM ref_prices
    WHERE UPPER(REGEXP_REPLACE(
             REGEXP_REPLACE(COALESCE(part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
             '[[:space:]]+', '', 'g'
           )) = ANY(${canons}::text[])
  `;
  const idByCanon = new Map<string, string>();
  for (const r of idRows) if (!idByCanon.has(r.canon)) idByCanon.set(r.canon, r.id);

  let recorded = 0;
  for (const [canon, g] of byCanon) {
    const refPriceId = idByCanon.get(canon);
    if (!refPriceId) continue; // autoTrackParts guarantees a row; defensive only
    const price = +(g.priceQty / g.qty).toFixed(2);
    await appendPriceEvent(tx, {
      refPriceId,
      price,
      source: `sale:${sellOrderId}`,
      note: null,
      actorUserId,
    });
    recorded++;
  }
  return { recorded };
}
```

- [ ] **Step 4: Wire it into the Done block**

In `apps/backend/src/routes/sellOrders.ts`, add the import near the other lib imports (next to `import { autoTrackParts } from '../lib/marketAutoTrack';` in that file's import block — note this route imports from `../lib/...`):

```typescript
import { recordSaleDataPoints } from '../lib/sellOrderMarket';
```

Then, inside the `if (body.to === 'Done') { … }` block, immediately before `}` that closes it and after the `for (const s of submitters) { … }` notification loop, add:

```typescript
      // A completed sale is the most authoritative price signal we have —
      // record one market data point per sold product.
      await recordSaleDataPoints(tx, id, u.id);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/sell-order-market-datapoint.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the neighboring suites to check for regressions**

Run: `cd apps/backend && npx vitest run tests/sell-done-line.test.ts tests/sell-done-race.test.ts tests/sell-order-done-transitions.test.ts tests/market-manual-price.test.ts`
Expected: PASS — Done transitions and the market write path are unaffected.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/lib/sellOrderMarket.ts apps/backend/src/routes/sellOrders.ts apps/backend/tests/sell-order-market-datapoint.test.ts
git commit -m "feat: record a market data point when a sell order completes"
```

---

## Self-Review

**Spec coverage:**
- Trigger on Done, not Closed → Task 3 (Done wiring + "Closed" test). ✓
- Data point via `appendPriceEvent`, aggregates untouched → Task 3 helper + `samples` assertion. ✓
- USD basis, no FX conversion → Task 3 CNY test asserts `last_price` = converted USD `unit_price`. ✓
- Qty-weighted rollup per canonical PN → Task 1 (canon) + Task 3 rollup test. ✓
- Auto-create missing row with real label → Task 2 (label extension) + Task 3 auto-create test asserting `label`. ✓
- Skip lines with no part number → Task 3 no-PN test. ✓
- Atomic inside Done tx → Task 3 wiring places the call inside `sql.begin`. ✓
- No schema/migration, no frontend change → nothing added. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `canonPartNumberJs(string): string` (defined Task 1, used Task 3); `TrackablePart.label/subLabel` (Task 2, used Task 3); `recordSaleDataPoints(tx, sellOrderId, actorUserId)` (defined + called Task 3); `appendPriceEvent` arg shape matches `refPriceEvents.ts`. Consistent.
