# Warehouse Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `WAREHOUSE_EXTRAS` lookup with real, per-warehouse persisted detail fields (address, manager + phone/email, IANA timezone, HH:MM cutoff, sqft), and remove the fake header subtitle and per-card capacity bar.

**Architecture:** Add nullable columns to the existing `warehouses` table; the seed migration backfills the values currently hardcoded in the frontend. Backend route validates and round-trips them in camelCase. Frontend deletes the hardcoded extras, expands the edit modal, and renders card rows conditionally so warehouses without details show no filler.

**Tech Stack:** Postgres (via `postgres` npm), Hono (Cloudflare Worker), React + TypeScript. No automated test framework exists in this repo, so each task ends with a manual verification step (curl for backend, browser for frontend) plus a `pnpm typecheck` to catch regressions.

**Spec:** `docs/superpowers/specs/2026-05-12-warehouse-details-design.md`

---

## File Structure

**Modified / created:**

- Create — `apps/backend/migrations/0007_warehouse_details.sql`
  Adds 7 nullable columns to `warehouses` and backfills the 5 seeded rows.

- Modify — `apps/backend/src/routes/warehouses.ts`
  GET selects new columns, returns camelCase. POST/PATCH accept + validate new fields. PATCH switches from blanket COALESCE to per-field handling so optional fields can be cleared with `null` / empty string.

- Modify — `apps/backend/scripts/seed.mjs`
  Extend the `WAREHOUSES` constant with the new fields and update its INSERT to write them, so `pnpm db:reset` produces complete data.

- Modify — `apps/frontend/src/lib/types.ts`
  Extend `Warehouse` with the new optional fields.

- Modify — `apps/frontend/src/pages/desktop/DesktopSettings.tsx`
  Delete `WAREHOUSE_EXTRAS` / `WAREHOUSE_EXTRAS_DEFAULT` / `WarehouseExtras`. Simplify `WarehouseRow`. Remove the header subtitle, `totalSqft` / `avgCapacity` / `activeCount` computations, and the per-card `.wh-capacity` block. Add `tzAbbrev` helper. Render card rows conditionally. Expand `WarehouseEditModal` with all new form fields.

The two halves of the DesktopSettings change (panel cleanup vs. modal expansion) are split into separate tasks so each diff stays focused.

---

## Task 1: Schema migration + backfill

**Files:**
- Create: `apps/backend/migrations/0007_warehouse_details.sql`

- [ ] **Step 1: Write the migration file**

Create `apps/backend/migrations/0007_warehouse_details.sql` with this exact content:

```sql
-- 0007_warehouse_details.sql
-- Persist warehouse detail fields that previously lived in a hardcoded
-- frontend lookup (WAREHOUSE_EXTRAS in DesktopSettings.tsx).

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS address        TEXT,
  ADD COLUMN IF NOT EXISTS manager        TEXT,
  ADD COLUMN IF NOT EXISTS manager_phone  TEXT,
  ADD COLUMN IF NOT EXISTS manager_email  TEXT,
  ADD COLUMN IF NOT EXISTS timezone       TEXT,
  ADD COLUMN IF NOT EXISTS cutoff_local   TEXT,  -- 'HH:MM' in the warehouse's tz
  ADD COLUMN IF NOT EXISTS sqft           INTEGER;

-- Backfill the values that were hardcoded in the frontend, keyed by short code.
-- Manager phone/email were not in the hardcoded data, so they stay NULL.

UPDATE warehouses SET
  address      = '2401 E. 8th St, Los Angeles, CA 90021',
  manager      = 'Operations · West',
  timezone     = 'America/Los_Angeles',
  cutoff_local = '15:00',
  sqft         = 14200
WHERE short = 'LA1';

UPDATE warehouses SET
  address      = '6900 Ambassador Row, Dallas, TX 75247',
  manager      = 'Operations · Central',
  timezone     = 'America/Chicago',
  cutoff_local = '14:00',
  sqft         = 9800
WHERE short = 'DAL';

UPDATE warehouses SET
  address      = '180 Raymond Blvd, Newark, NJ 07102',
  manager      = 'Operations · East',
  timezone     = 'America/New_York',
  cutoff_local = '16:00',
  sqft         = 11600
WHERE short = 'NJ2';

UPDATE warehouses SET
  address      = 'Unit 12, Goodman Tsing Yi, Hong Kong',
  manager      = 'APAC Hub',
  timezone     = 'Asia/Hong_Kong',
  cutoff_local = '17:00',
  sqft         = 8200
WHERE short = 'HK';

UPDATE warehouses SET
  address      = 'Schiphol Logistics Park, 1118 BE Amsterdam',
  manager      = 'EMEA Hub',
  timezone     = 'Europe/Amsterdam',
  cutoff_local = '16:00',
  sqft         = 7400
WHERE short = 'AMS';
```

- [ ] **Step 2: Apply the migration**

Run from the backend package directory:

```bash
cd apps/backend && pnpm db:migrate
```

The migrate script reads every `.sql` in `migrations/` in sorted order. Earlier migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, etc.), so re-running them is safe.

Expected output: lines ending with `→ 0007_warehouse_details.sql` then `✓ migrations applied`.

- [ ] **Step 3: Verify columns and backfill**

Use the same `DATABASE_URL` that the migrate script picked up. You can verify with `psql` if installed, or via a one-off node snippet:

```bash
cd apps/backend && node -e "
import('postgres').then(async ({ default: postgres }) => {
  await import('dotenv/config');
  const fs = await import('node:fs');
  try {
    for (const line of fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
  const sql = postgres(process.env.DATABASE_URL);
  const rows = await sql\`SELECT short, address, manager, timezone, cutoff_local, sqft FROM warehouses ORDER BY short\`;
  console.table(rows);
  await sql.end();
});
"
```

Expected: 5 rows (LA1/DAL/NJ2/HK/AMS) with the values from the migration. `manager_phone` / `manager_email` columns exist but are NULL on all rows.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/migrations/0007_warehouse_details.sql
git commit -m "feat(backend): warehouse_details columns + backfill (migration 0007)"
```

---

## Task 2: Backend route — GET / POST / PATCH

**Files:**
- Modify: `apps/backend/src/routes/warehouses.ts`

- [ ] **Step 1: Replace the route file contents**

Replace the entire file `apps/backend/src/routes/warehouses.ts` with:

```ts
import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const warehouses = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// ── helpers ─────────────────────────────────────────────────────────────────

const norm = (s: unknown) => (typeof s === 'string' ? s.trim() : '');

// Optional-string field: undefined → leave column alone; null/'' → clear;
// non-empty → trim and use.
type FieldUpdate<T> = { set: true; value: T | null } | { set: false };

const optionalString = (raw: unknown): FieldUpdate<string> => {
  if (raw === undefined) return { set: false };
  if (raw === null) return { set: true, value: null };
  if (typeof raw !== 'string') return { set: true, value: null };
  const t = raw.trim();
  return { set: true, value: t === '' ? null : t };
};

const optionalInt = (raw: unknown): FieldUpdate<number> => {
  if (raw === undefined) return { set: false };
  if (raw === null || raw === '') return { set: true, value: null };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { set: true, value: NaN };
  return { set: true, value: n };
};

const CUTOFF_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type DetailInput = {
  address?: FieldUpdate<string>;
  manager?: FieldUpdate<string>;
  managerPhone?: FieldUpdate<string>;
  managerEmail?: FieldUpdate<string>;
  timezone?: FieldUpdate<string>;
  cutoffLocal?: FieldUpdate<string>;
  sqft?: FieldUpdate<number>;
};

// Returns { input, error }. `error` is a string for the first invalid field
// encountered; otherwise null.
function parseDetails(body: Record<string, unknown>): { input: DetailInput; error: string | null } {
  const input: DetailInput = {
    address:      optionalString(body.address),
    manager:      optionalString(body.manager),
    managerPhone: optionalString(body.managerPhone),
    managerEmail: optionalString(body.managerEmail),
    timezone:     optionalString(body.timezone),
    cutoffLocal:  optionalString(body.cutoffLocal),
    sqft:         optionalInt(body.sqft),
  };

  if (input.cutoffLocal?.set && input.cutoffLocal.value !== null
      && !CUTOFF_RE.test(input.cutoffLocal.value)) {
    return { input, error: 'cutoffLocal must be HH:MM (00:00 – 23:59)' };
  }
  if (input.managerEmail?.set && input.managerEmail.value !== null
      && !input.managerEmail.value.includes('@')) {
    return { input, error: 'managerEmail must contain @' };
  }
  if (input.sqft?.set && input.sqft.value !== null
      && (Number.isNaN(input.sqft.value) || input.sqft.value < 0)) {
    return { input, error: 'sqft must be a non-negative integer' };
  }
  return { input, error: null };
}

// Maps the 7 detail columns (snake_case) to camelCase keys in API responses.
const DETAIL_COLS = [
  ['address',       'address'],
  ['manager',       'manager'],
  ['manager_phone', 'managerPhone'],
  ['manager_email', 'managerEmail'],
  ['timezone',      'timezone'],
  ['cutoff_local',  'cutoffLocal'],
  ['sqft',          'sqft'],
] as const;

// ── routes ──────────────────────────────────────────────────────────────────

warehouses.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, name, short, region,
           address, manager, manager_phone, manager_email,
           timezone, cutoff_local, sqft
    FROM warehouses
    ORDER BY region, short
  `;
  // postgres.js returns snake_case keys; remap to camelCase.
  const items = rows.map((r: Record<string, unknown>) => ({
    id: r.id, name: r.name, short: r.short, region: r.region,
    address:      r.address      ?? null,
    manager:      r.manager      ?? null,
    managerPhone: r.manager_phone ?? null,
    managerEmail: r.manager_email ?? null,
    timezone:     r.timezone     ?? null,
    cutoffLocal:  r.cutoff_local ?? null,
    sqft:         r.sqft         ?? null,
  }));
  return c.json({ items });
});

warehouses.post('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const name = norm(body.name);
  const short = norm(body.short).toUpperCase();
  const region = norm(body.region);
  if (!name || !short || !region) {
    return c.json({ error: 'name, short, region are required' }, 400);
  }
  const id = norm(body.id) || `WH-${short}`;

  const { input, error } = parseDetails(body);
  if (error) return c.json({ error }, 400);

  const val = (f?: FieldUpdate<string | number>) => (f?.set ? f.value : null);

  const sql = getDb(c.env);
  try {
    const r = await sql`
      INSERT INTO warehouses (
        id, name, short, region,
        address, manager, manager_phone, manager_email,
        timezone, cutoff_local, sqft
      )
      VALUES (
        ${id}, ${name}, ${short}, ${region},
        ${val(input.address)},     ${val(input.manager)},
        ${val(input.managerPhone)}, ${val(input.managerEmail)},
        ${val(input.timezone)},    ${val(input.cutoffLocal)},
        ${val(input.sqft)}
      )
      RETURNING id, name, short, region,
                address, manager, manager_phone, manager_email,
                timezone, cutoff_local, sqft
    `;
    const row = r[0] as Record<string, unknown>;
    return c.json({
      id: row.id, name: row.name, short: row.short, region: row.region,
      address:      row.address      ?? null,
      manager:      row.manager      ?? null,
      managerPhone: row.manager_phone ?? null,
      managerEmail: row.manager_email ?? null,
      timezone:     row.timezone     ?? null,
      cutoffLocal:  row.cutoff_local ?? null,
      sqft:         row.sqft         ?? null,
    }, 201);
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? '';
    if (/duplicate|unique/i.test(msg)) {
      return c.json({ error: `Warehouse "${id}" already exists` }, 409);
    }
    throw e;
  }
});

warehouses.patch('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  // Required-field updates (cannot be cleared): if the key is present it must be non-empty.
  const name   = body.name   !== undefined ? norm(body.name)                : null;
  const short  = body.short  !== undefined ? norm(body.short).toUpperCase() : null;
  const region = body.region !== undefined ? norm(body.region)              : null;
  if (name === '' || short === '' || region === '') {
    return c.json({ error: 'name, short, region cannot be empty' }, 400);
  }

  const { input, error } = parseDetails(body);
  if (error) return c.json({ error }, 400);

  // Build the UPDATE dynamically using postgres.js's tagged template.
  // We use a single statement with conditional COALESCE on required fields
  // (preserves existing value when null arg is passed) and explicit nullable
  // sets for optional fields gated by a per-field "set" flag.
  const sql = getDb(c.env);

  // Encode "set or leave alone" by passing the current column on "leave alone":
  // `${input.address.set ? input.address.value : sql('address')}` is the
  // cleanest way, but postgres.js's fragment helper differs across versions.
  // Simpler: pass a flag + value pair and use SQL CASE.
  const flag = (f?: FieldUpdate<string | number>) => (f?.set ? 1 : 0);
  const val  = (f?: FieldUpdate<string | number>) => (f?.set ? f.value : null);

  const r = await sql`
    UPDATE warehouses SET
      name           = COALESCE(${name},   name),
      short          = COALESCE(${short},  short),
      region         = COALESCE(${region}, region),
      address        = CASE WHEN ${flag(input.address)}::int      = 1 THEN ${val(input.address)}      ELSE address        END,
      manager        = CASE WHEN ${flag(input.manager)}::int      = 1 THEN ${val(input.manager)}      ELSE manager        END,
      manager_phone  = CASE WHEN ${flag(input.managerPhone)}::int = 1 THEN ${val(input.managerPhone)} ELSE manager_phone  END,
      manager_email  = CASE WHEN ${flag(input.managerEmail)}::int = 1 THEN ${val(input.managerEmail)} ELSE manager_email  END,
      timezone       = CASE WHEN ${flag(input.timezone)}::int     = 1 THEN ${val(input.timezone)}     ELSE timezone       END,
      cutoff_local   = CASE WHEN ${flag(input.cutoffLocal)}::int  = 1 THEN ${val(input.cutoffLocal)}  ELSE cutoff_local   END,
      sqft           = CASE WHEN ${flag(input.sqft)}::int         = 1 THEN ${val(input.sqft)}         ELSE sqft           END
    WHERE id = ${id}
    RETURNING id, name, short, region,
              address, manager, manager_phone, manager_email,
              timezone, cutoff_local, sqft
  `;
  if (r.length === 0) return c.json({ error: 'not found' }, 404);
  const row = r[0] as Record<string, unknown>;
  return c.json({
    id: row.id, name: row.name, short: row.short, region: row.region,
    address:      row.address      ?? null,
    manager:      row.manager      ?? null,
    managerPhone: row.manager_phone ?? null,
    managerEmail: row.manager_email ?? null,
    timezone:     row.timezone     ?? null,
    cutoffLocal:  row.cutoff_local ?? null,
    sqft:         row.sqft         ?? null,
  });
});

// DELETE /:id[?transferTo=<warehouseId>] — unchanged.
warehouses.delete('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const transferToRaw = c.req.query('transferTo');
  const transferTo = transferToRaw && transferToRaw.trim() ? transferToRaw.trim() : null;
  if (transferTo === id) return c.json({ error: 'transferTo must differ from the warehouse being deleted' }, 400);

  const sql = getDb(c.env);

  if (transferTo) {
    const exists = await sql`SELECT id FROM warehouses WHERE id = ${transferTo}`;
    if (exists.length === 0) return c.json({ error: `transferTo warehouse "${transferTo}" not found` }, 404);
  }

  let deleted = 0;
  await sql.begin(async (tx) => {
    await tx`UPDATE orders          SET warehouse_id = ${transferTo} WHERE warehouse_id = ${id}`;
    await tx`UPDATE sell_order_lines SET warehouse_id = ${transferTo} WHERE warehouse_id = ${id}`;
    const r = await tx`DELETE FROM warehouses WHERE id = ${id} RETURNING id`;
    deleted = r.length;
  });
  if (deleted === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

export default warehouses;
```

Note: the `DETAIL_COLS` constant in the helpers section is currently unreferenced and may be removed. It's kept in case follow-up work wants a single source of truth for the col→key mapping.

- [ ] **Step 2: Typecheck**

```bash
cd apps/backend && pnpm typecheck
```

Expected: exits 0 with no output.

- [ ] **Step 3: Start the dev worker and smoke-test GET**

In one terminal:

```bash
cd apps/backend && pnpm dev
```

Wait for `wrangler dev` to print a local URL (default `http://localhost:8787`).

In a second terminal, log in as a seeded manager to grab a token, then call GET. Use whatever login flow the rest of the app uses — easiest is to copy the bearer token from your browser's localStorage (`recycle_erp_token`) after logging into the frontend in any prior session. Save it:

```bash
export TOKEN="<paste token here>"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/warehouses | python3 -m json.tool
```

Expected: each item has `address`, `manager`, `managerPhone` (null), `managerEmail` (null), `timezone`, `cutoffLocal`, `sqft` keys.

- [ ] **Step 4: Smoke-test PATCH (set + clear)**

Pick any warehouse id from the GET output (e.g. `WH-LA1`). Set the manager phone/email:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"managerPhone":"+1 213 555 0142","managerEmail":"la1-ops@example.com"}' \
  http://localhost:8787/api/warehouses/WH-LA1 | python3 -m json.tool
```

Expected: returned row shows both new fields set. Other fields unchanged.

Now clear them with empty strings:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"managerPhone":"","managerEmail":null}' \
  http://localhost:8787/api/warehouses/WH-LA1 | python3 -m json.tool
```

Expected: returned row has `managerPhone: null` and `managerEmail: null`. Address/timezone/cutoff/sqft from the backfill are unchanged.

- [ ] **Step 5: Smoke-test PATCH validation**

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"cutoffLocal":"25:00"}' http://localhost:8787/api/warehouses/WH-LA1
```

Expected: `{"error":"cutoffLocal must be HH:MM (00:00 – 23:59)"}` with HTTP 400.

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sqft":-5}' http://localhost:8787/api/warehouses/WH-LA1
```

Expected: `{"error":"sqft must be a non-negative integer"}`.

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"managerEmail":"nope"}' http://localhost:8787/api/warehouses/WH-LA1
```

Expected: `{"error":"managerEmail must contain @"}`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/warehouses.ts
git commit -m "feat(backend): warehouses GET/POST/PATCH round-trip detail fields"
```

---

## Task 3: Update seed script

**Files:**
- Modify: `apps/backend/scripts/seed.mjs`

- [ ] **Step 1: Extend the WAREHOUSES constant**

Open `apps/backend/scripts/seed.mjs`. Replace the `WAREHOUSES` array (the block currently at lines 47–53) with:

```js
const WAREHOUSES = [
  { id: 'WH-LA1', name: 'Los Angeles · LA1', short: 'LA1', region: 'US-West',
    address: '2401 E. 8th St, Los Angeles, CA 90021',
    manager: 'Operations · West',
    manager_phone: null,
    manager_email: null,
    timezone: 'America/Los_Angeles',
    cutoff_local: '15:00',
    sqft: 14200 },
  { id: 'WH-DAL', name: 'Dallas · DAL', short: 'DAL', region: 'US-Central',
    address: '6900 Ambassador Row, Dallas, TX 75247',
    manager: 'Operations · Central',
    manager_phone: null,
    manager_email: null,
    timezone: 'America/Chicago',
    cutoff_local: '14:00',
    sqft: 9800 },
  { id: 'WH-NJ2', name: 'Newark · NJ2', short: 'NJ2', region: 'US-East',
    address: '180 Raymond Blvd, Newark, NJ 07102',
    manager: 'Operations · East',
    manager_phone: null,
    manager_email: null,
    timezone: 'America/New_York',
    cutoff_local: '16:00',
    sqft: 11600 },
  { id: 'WH-HK', name: 'Hong Kong · HK', short: 'HK', region: 'APAC',
    address: 'Unit 12, Goodman Tsing Yi, Hong Kong',
    manager: 'APAC Hub',
    manager_phone: null,
    manager_email: null,
    timezone: 'Asia/Hong_Kong',
    cutoff_local: '17:00',
    sqft: 8200 },
  { id: 'WH-AMS', name: 'Amsterdam · AMS', short: 'AMS', region: 'EMEA',
    address: 'Schiphol Logistics Park, 1118 BE Amsterdam',
    manager: 'EMEA Hub',
    manager_phone: null,
    manager_email: null,
    timezone: 'Europe/Amsterdam',
    cutoff_local: '16:00',
    sqft: 7400 },
];
```

- [ ] **Step 2: Update the seed INSERT**

In the same file, find the warehouses seed loop (around line 344). Replace the existing INSERT statement so it writes the new columns. The block currently reads:

```js
console.log('· Seeding warehouses…');
for (const w of WAREHOUSES) {
  await sql`
    INSERT INTO warehouses (id, name, short, region)
    VALUES (${w.id}, ${w.name}, ${w.short}, ${w.region})
    ON CONFLICT (id) DO NOTHING
  `;
}
```

(If the actual file omits the `ON CONFLICT` clause, leave that wording as-is — only the column list and VALUES list need to change.) Replace the inner SQL with:

```js
console.log('· Seeding warehouses…');
for (const w of WAREHOUSES) {
  await sql`
    INSERT INTO warehouses (
      id, name, short, region,
      address, manager, manager_phone, manager_email,
      timezone, cutoff_local, sqft
    )
    VALUES (
      ${w.id}, ${w.name}, ${w.short}, ${w.region},
      ${w.address}, ${w.manager}, ${w.manager_phone}, ${w.manager_email},
      ${w.timezone}, ${w.cutoff_local}, ${w.sqft}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}
```

(Match the original surrounding code's quoting and indentation — keep `ON CONFLICT` only if it was already there.)

- [ ] **Step 3: Run db:reset to verify the seed works end-to-end**

```bash
cd apps/backend && pnpm db:reset
```

Expected: prints `· Dropping existing tables…`, then each migration, then seed output ending with `· Seeding warehouses…` and no errors.

- [ ] **Step 4: Verify seed row contents**

Repeat the verification query from Task 1 Step 3. Expected: 5 rows with full data (address/manager/timezone/cutoff_local/sqft populated; manager_phone/manager_email NULL).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/scripts/seed.mjs
git commit -m "feat(backend): seed warehouses with detail fields"
```

---

## Task 4: Frontend type

**Files:**
- Modify: `apps/frontend/src/lib/types.ts`

- [ ] **Step 1: Extend `Warehouse`**

Open `apps/frontend/src/lib/types.ts`. Find the `Warehouse` type (currently at lines 17–22):

```ts
export type Warehouse = {
  id: string;
  name?: string;
  short: string;
  region: string;
};
```

Replace with:

```ts
export type Warehouse = {
  id: string;
  name?: string;
  short: string;
  region: string;
  address?: string | null;
  manager?: string | null;
  managerPhone?: string | null;
  managerEmail?: string | null;
  timezone?: string | null;
  cutoffLocal?: string | null;   // 'HH:MM' in the warehouse's timezone
  sqft?: number | null;
};
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/frontend && pnpm typecheck
```

Expected: exits 0. (Any existing consumers should be unaffected because the new fields are optional. If errors appear, they signal that some other code already had a divergent definition — investigate before continuing.)

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/lib/types.ts
git commit -m "feat(frontend): warehouse detail fields on Warehouse type"
```

---

## Task 5: Settings panel — delete hardcoded extras, header subtitle, capacity bar

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

This task rewrites the `WarehousesPanel` function and removes the constants above it. The modal stays unchanged until Task 6.

- [ ] **Step 1: Delete the WAREHOUSE_EXTRAS block**

Open `apps/frontend/src/pages/desktop/DesktopSettings.tsx`. Find the block that currently looks like (lines 1480–1500):

```ts
// design visually until a richer schema lands.
type WarehouseExtras = {
  address: string;
  manager: string;
  timezone: string;
  cutoff: string;
  sqft: number;
  capacityPct: number;
};
const WAREHOUSE_EXTRAS_DEFAULT: WarehouseExtras = {
  address: '— address pending —', manager: '—', timezone: 'America/Los_Angeles',
  cutoff: '15:00 PT', sqft: 5000, capacityPct: 30,
};
const WAREHOUSE_EXTRAS: Record<string, WarehouseExtras> = {
  'LA1': { address: '2401 E. 8th St, Los Angeles, CA 90021',  manager: 'Operations · West',     timezone: 'America/Los_Angeles', cutoff: '15:00 PT',  sqft: 14200, capacityPct: 64 },
  'DAL': { address: '6900 Ambassador Row, Dallas, TX 75247',   manager: 'Operations · Central',  timezone: 'America/Chicago',     cutoff: '14:00 CT',  sqft:  9800, capacityPct: 41 },
  'NJ2': { address: '180 Raymond Blvd, Newark, NJ 07102',      manager: 'Operations · East',     timezone: 'America/New_York',    cutoff: '16:00 ET',  sqft: 11600, capacityPct: 78 },
  'HK':  { address: 'Unit 12, Goodman Tsing Yi, Hong Kong',    manager: 'APAC Hub',              timezone: 'Asia/Hong_Kong',      cutoff: '17:00 HKT', sqft:  8200, capacityPct: 86 },
  'AMS': { address: 'Schiphol Logistics Park, 1118 BE Amsterdam', manager: 'EMEA Hub',           timezone: 'Europe/Amsterdam',    cutoff: '16:00 CET', sqft:  7400, capacityPct: 52 },
};
type WarehouseRow = Warehouse & WarehouseExtras & { active: boolean; receiving: boolean };
```

Also delete any orphaned comment line immediately above it that says something like "// design visually until a richer schema lands." (the trailing fragment shown on line 1480). Replace the whole block with:

```ts
type WarehouseRow = Warehouse & { active: boolean; receiving: boolean };

// Derive a short timezone abbreviation (e.g. 'PT', 'CET') from an IANA zone.
// Returns '' if the zone is missing or the Intl call fails.
function tzAbbrev(timeZone: string | null | undefined): string {
  if (!timeZone) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, timeZoneName: 'short',
    }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 2: Rewrite the WarehousesPanel function**

In the same file, replace the entire `WarehousesPanel` function (currently lines 1502–1661 — the function ends with its closing `}` before `function WarehouseEditModal({`). Use this exact body:

```tsx
function WarehousesPanel({ showToast }: { showToast: ToastFn }) {
  const [whs, setWhs] = useState<WarehouseRow[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [modalWh, setModalWh] = useState<Warehouse | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () => api.get<{ items: Warehouse[] }>('/api/warehouses')
    .then(r => {
      setWhs(r.items.map(w => ({
        ...w,
        active: true,
        receiving: w.short !== 'HK',
      })));
    })
    .catch(console.error)
    .finally(() => setLoadedOnce(true));
  useEffect(() => { reload(); }, []);

  const updateRow = (id: string, patch: Partial<WarehouseRow>) =>
    setWhs(prev => prev.map(w => w.id === id ? { ...w, ...patch } : w));

  return (
    <>
      <SettingsHeader
        title="Warehouses"
        actions={
          <button className="btn accent" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> Add warehouse
          </button>
        }
      />

      <div className="wh-grid">
        {!loadedOnce && Array.from({ length: 3 }).map((_, i) => (
          <div key={`sk-${i}`} className="card wh-card">
            <div className="wh-card-head">
              <div className="wh-card-id">
                <span className="skeleton" style={{ width: 32, height: 32, borderRadius: 8, display: 'inline-block' }} aria-hidden />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="skeleton" style={{ width: '60%', height: 14, borderRadius: 4, display: 'inline-block' }} aria-hidden />
                  <span className="skeleton" style={{ width: '40%', height: 11, borderRadius: 4, display: 'inline-block' }} aria-hidden />
                </div>
              </div>
            </div>
            <div className="wh-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}>
              <span className="skeleton" style={{ width: '100%', height: 12, borderRadius: 4, display: 'inline-block' }} aria-hidden />
              <span className="skeleton" style={{ width: '85%', height: 12, borderRadius: 4, display: 'inline-block' }} aria-hidden />
              <span className="skeleton" style={{ width: '70%', height: 12, borderRadius: 4, display: 'inline-block' }} aria-hidden />
            </div>
          </div>
        ))}
        {whs.map(w => {
          const abbrev = tzAbbrev(w.timezone);
          const cutoffDisplay = w.cutoffLocal
            ? (abbrev ? `${w.cutoffLocal} ${abbrev}` : w.cutoffLocal)
            : null;
          return (
            <div key={w.id} className={'card wh-card' + (w.active ? '' : ' archived')}>
              <div className="wh-card-head">
                <div className="wh-card-id">
                  <div className="wh-icon"><Icon name="warehouse" size={16} /></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="wh-card-name">{w.name ?? w.short}</div>
                    <div className="wh-card-region">{w.region} · {w.short}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    className="btn icon sm ghost"
                    onClick={() => setModalWh(w)}
                    title="Open full editor"
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    <Icon name="settings" size={13} />
                  </button>
                </div>
              </div>

              <div className="wh-card-body">
                {w.address && (
                  <div className="wh-row">
                    <span className="wh-row-label">Address</span>
                    <span className="wh-row-val">{w.address}</span>
                  </div>
                )}
                {w.manager && (
                  <div className="wh-row">
                    <span className="wh-row-label">Manager</span>
                    <span className="wh-row-val">{w.manager}</span>
                  </div>
                )}
                {w.managerPhone && (
                  <div className="wh-row">
                    <span className="wh-row-label">Phone</span>
                    <span className="wh-row-val mono" style={{ fontSize: 12.5 }}>{w.managerPhone}</span>
                  </div>
                )}
                {w.managerEmail && (
                  <div className="wh-row">
                    <span className="wh-row-label">Email</span>
                    <span className="wh-row-val">{w.managerEmail}</span>
                  </div>
                )}
                {w.timezone && (
                  <div className="wh-row">
                    <span className="wh-row-label">Timezone</span>
                    <span className="wh-row-val mono" style={{ fontSize: 12.5 }}>{w.timezone}</span>
                  </div>
                )}
                {cutoffDisplay && (
                  <div className="wh-row">
                    <span className="wh-row-label">Receiving cutoff</span>
                    <span className="wh-row-val mono" style={{ fontSize: 12.5 }}>{cutoffDisplay}</span>
                  </div>
                )}
                {w.sqft != null && (
                  <div className="wh-row">
                    <span className="wh-row-label">Floor area</span>
                    <span className="wh-row-val mono">{w.sqft.toLocaleString()} sq ft</span>
                  </div>
                )}
              </div>

              <div className="wh-card-foot">
                <div className="toggle-row">
                  <span>Active</span>
                  <Toggle checked={w.active} onChange={(v) => updateRow(w.id, { active: v })} />
                </div>
                <div className="toggle-row">
                  <span>Accepting receipts</span>
                  <Toggle
                    checked={w.receiving}
                    onChange={(v) => updateRow(w.id, { receiving: v })}
                    disabled={!w.active}
                  />
                </div>
              </div>
            </div>
          );
        })}

        <button type="button" className="card wh-add" onClick={() => setCreating(true)}>
          <div className="wh-add-icon"><Icon name="plus" size={20} /></div>
          <div className="wh-add-text">
            <div style={{ fontWeight: 600, fontSize: 14 }}>Add warehouse</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>New location for receiving inventory</div>
          </div>
        </button>
      </div>

      {(modalWh || creating) && (
        <WarehouseEditModal
          warehouse={modalWh}
          others={whs.filter(w => w.id !== modalWh?.id)}
          onClose={() => { setModalWh(null); setCreating(false); }}
          onSaved={(msg) => { setModalWh(null); setCreating(false); reload(); showToast?.(msg); }}
          onError={(msg) => showToast?.(msg, 'error')}
        />
      )}
    </>
  );
}
```

Changes vs. the original:
- `SettingsHeader` no longer receives a `sub` prop (subtitle gone).
- `reload()` no longer merges `WAREHOUSE_EXTRAS` — server data is used as-is.
- `totalSqft` / `avgCapacity` / `activeCount` computations are gone.
- The `.wh-capacity` block on each card is gone.
- Card body rows render conditionally — no `—` filler, no "address pending" placeholder.

- [ ] **Step 2: Typecheck**

```bash
cd apps/frontend && pnpm typecheck
```

Expected: exits 0. (At this point the `WarehouseEditModal` is still the old version that only edits name/short/region — that's fine; we'll expand it in Task 6.)

- [ ] **Step 3: Visual verification in the browser**

In one terminal:

```bash
cd apps/backend && pnpm dev
```

In another:

```bash
cd apps/frontend && pnpm dev
```

Open the Vite URL (typically `http://localhost:5173`), sign in as a manager, navigate to Settings → Warehouses. Verify:
- The subtitle line ("X active · Y sq ft total · Z% avg capacity") is **gone**.
- Each card shows address/manager/timezone/cutoff/floor-area rows with the backfilled values (no "— address pending —").
- The "Receiving cutoff" row shows e.g. `15:00 PT`, derived from `cutoffLocal` + the timezone abbrev.
- The per-card capacity bar at the bottom is **gone** (only the Active / Accepting receipts toggles remain in the footer).
- The "Add warehouse" tile still appears at the end of the grid.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "feat(desktop): warehouse cards render from real DB data; drop fake subtitle and capacity bar"
```

---

## Task 6: Expand the warehouse edit modal

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

- [ ] **Step 1: Replace the WarehouseEditModal function**

In `apps/frontend/src/pages/desktop/DesktopSettings.tsx`, find `function WarehouseEditModal({` (begins around line 1663 in the pre-Task-5 file, slightly different after Task 5). Replace the entire function — from `function WarehouseEditModal({` through its matching closing brace — with:

```tsx
// Built-in IANA list when the browser supports Intl.supportedValuesOf, else a
// curated fallback covering the regions this app currently uses.
function timezoneOptions(): string[] {
  type IntlExtra = typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  const fn = (Intl as IntlExtra).supportedValuesOf;
  if (typeof fn === 'function') {
    try {
      const list = fn.call(Intl, 'timeZone');
      if (Array.isArray(list) && list.length > 0) return list;
    } catch { /* fall through */ }
  }
  return [
    'UTC',
    'America/Los_Angeles',
    'America/Denver',
    'America/Chicago',
    'America/New_York',
    'Europe/London',
    'Europe/Amsterdam',
    'Europe/Berlin',
    'Asia/Hong_Kong',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney',
  ];
}

function WarehouseEditModal({
  warehouse, others, onClose, onSaved, onError,
}: {
  warehouse: Warehouse | null;
  others: Warehouse[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const isNew = !warehouse;

  type Draft = {
    name: string;
    short: string;
    region: string;
    address: string;
    manager: string;
    managerPhone: string;
    managerEmail: string;
    timezone: string;
    cutoffLocal: string;   // 'HH:MM' or ''
    sqft: string;          // string in the form, parsed on save
  };

  const [draft, setDraft] = useState<Draft>({
    name:         warehouse?.name ?? '',
    short:        warehouse?.short ?? '',
    region:       warehouse?.region ?? '',
    address:      warehouse?.address ?? '',
    manager:      warehouse?.manager ?? '',
    managerPhone: warehouse?.managerPhone ?? '',
    managerEmail: warehouse?.managerEmail ?? '',
    timezone:     warehouse?.timezone ?? '',
    cutoffLocal:  warehouse?.cutoffLocal ?? '',
    sqft:         warehouse?.sqft != null ? String(warehouse.sqft) : '',
  });

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [transferTo, setTransferTo] = useState<string>('');

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft(prev => ({ ...prev, [k]: v }));

  const canSave = draft.name.trim() && draft.short.trim() && draft.region.trim();

  const tzOptions = timezoneOptions();

  const save = async () => {
    setSaving(true);
    try {
      // Build the payload. Empty strings on optional fields become null so
      // the server clears the column. sqft becomes null when blank, otherwise
      // a number (server validates it's a non-negative integer).
      const opt = (s: string): string | null => {
        const t = s.trim();
        return t === '' ? null : t;
      };
      const sqftPayload: number | null = (() => {
        const t = draft.sqft.trim();
        if (t === '') return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : NaN as unknown as number;
      })();

      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        short: draft.short.trim(),
        region: draft.region.trim(),
        address: opt(draft.address),
        manager: opt(draft.manager),
        managerPhone: opt(draft.managerPhone),
        managerEmail: opt(draft.managerEmail),
        timezone: opt(draft.timezone),
        cutoffLocal: opt(draft.cutoffLocal),
        sqft: sqftPayload,
      };

      if (isNew) await api.post('/api/warehouses', body);
      else       await api.patch(`/api/warehouses/${warehouse!.id}`, body);
      onSaved(isNew ? 'Warehouse created' : 'Warehouse saved');
    } catch (e) {
      onError((e as { message?: string })?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!warehouse) return;
    setDeleting(true);
    try {
      const qs = transferTo ? `?transferTo=${encodeURIComponent(transferTo)}` : '';
      await api.delete(`/api/warehouses/${warehouse.id}${qs}`);
      onSaved('Warehouse deleted');
    } catch (e) {
      onError((e as { message?: string })?.message ?? 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{isNew ? 'New warehouse' : 'Edit warehouse'}</div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label className="label">Name</label>
              <input className="input" value={draft.name} onChange={e => set('name', e.target.value)} />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label className="label">Short code</label>
              <input
                className="input mono"
                value={draft.short}
                onChange={e => set('short', e.target.value.toUpperCase())}
                placeholder="e.g. LA1"
              />
            </div>
            <div className="field">
              <label className="label">Region</label>
              <input className="input" value={draft.region} onChange={e => set('region', e.target.value)} placeholder="e.g. US-West" />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label className="label">Address</label>
              <textarea
                className="input"
                rows={3}
                value={draft.address}
                onChange={e => set('address', e.target.value)}
                placeholder="Street, city, state, postal code, country"
              />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label className="label">Manager</label>
              <input className="input" value={draft.manager} onChange={e => set('manager', e.target.value)} placeholder="Name or team" />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label className="label">Manager phone</label>
              <input
                className="input mono"
                type="tel"
                value={draft.managerPhone}
                onChange={e => set('managerPhone', e.target.value)}
                placeholder="+1 213 555 0142"
              />
            </div>
            <div className="field">
              <label className="label">Manager email</label>
              <input
                className="input"
                type="email"
                value={draft.managerEmail}
                onChange={e => set('managerEmail', e.target.value)}
                placeholder="ops@example.com"
              />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label className="label">Timezone</label>
              <select
                className="input"
                value={draft.timezone}
                onChange={e => set('timezone', e.target.value)}
              >
                <option value="">(none)</option>
                {tzOptions.map(tz => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label">Receiving cutoff</label>
              <input
                className="input mono"
                type="time"
                value={draft.cutoffLocal}
                onChange={e => set('cutoffLocal', e.target.value)}
              />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label className="label">Floor area (sq ft)</label>
              <input
                className="input mono"
                type="number"
                min={0}
                step={100}
                value={draft.sqft}
                onChange={e => set('sqft', e.target.value)}
                placeholder="e.g. 12000"
              />
            </div>
          </div>

          {!isNew && (
            <div className="field-row">
              <div className="field">
                <label className="label">ID</label>
                <input className="input mono" value={warehouse!.id} disabled />
              </div>
            </div>
          )}

          {!isNew && confirmingDelete && (
            <div
              style={{
                marginTop: 12, padding: 12, borderRadius: 6,
                border: '1px solid var(--neg)', background: 'var(--bg-elev)',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                Delete warehouse "{warehouse!.name ?? warehouse!.short}"?
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginBottom: 10 }}>
                Existing orders and sell-orders referencing this warehouse will be moved to the warehouse you pick below. This cannot be undone.
              </div>
              <div className="field">
                <label className="label">Move inventory to</label>
                <select
                  className="input"
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                >
                  <option value="">(none — clear warehouse from records)</option>
                  {others.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.name ?? w.short} · {w.region}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <div>
            {!isNew && !confirmingDelete && (
              <button
                className="btn"
                onClick={() => setConfirmingDelete(true)}
                disabled={deleting || saving}
                style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }}
              >
                Delete
              </button>
            )}
            {!isNew && confirmingDelete && (
              <button
                className="btn"
                onClick={() => { setConfirmingDelete(false); setTransferTo(''); }}
                disabled={deleting}
              >
                Cancel delete
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!isNew && confirmingDelete && (
              <button
                className="btn"
                onClick={remove}
                disabled={deleting}
                style={{ background: 'var(--neg)', color: 'white', borderColor: 'var(--neg)' }}
              >
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
            )}
            <button className="btn" onClick={onClose} disabled={saving || deleting}>Cancel</button>
            <button className="btn accent" onClick={save} disabled={!canSave || saving || deleting}>
              {saving ? 'Saving…' : (isNew ? 'Create' : 'Save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

Important: the modal footer's exact button arrangement (Cancel, Confirm delete, Cancel delete) should match the existing pre-Task-5 implementation. The code above keeps the same logical buttons; if the original file uses slightly different button labels or wrapping, **preserve the original's wording and structure for the footer buttons** — only the body fields change.

Concretely: if the original ended with something like

```tsx
<button className="btn" onClick={onClose}>Close</button>
```

keep that text. The point of this step is to expand the **body**; the footer is unchanged from whatever currently ships in `WarehouseEditModal`.

- [ ] **Step 2: Typecheck**

```bash
cd apps/frontend && pnpm typecheck
```

Expected: exits 0.

- [ ] **Step 3: Manual UI verification**

With both dev servers running (Task 5 Step 3), in the browser:

1. Settings → Warehouses → click the gear icon on `LA1`. Modal opens. Address textarea shows the backfilled address; manager shows `Operations · West`; timezone shows `America/Los_Angeles`; receiving cutoff time-picker shows `15:00`; sqft shows `14200`. Manager phone/email are empty.
2. Enter manager phone `+1 213 555 0142` and email `la1-ops@example.com`. Click Save. Toast says "Warehouse saved". Card now shows phone and email rows.
3. Re-open the modal, clear address (delete textarea contents), click Save. Card no longer shows the Address row.
4. Re-open, set cutoff to `09:30`, click Save. Card shows `09:30 PT` (or current zone abbrev).
5. Click "Add warehouse". Modal opens with empty fields. Enter name/short/region only and click Create. New card appears with name/short/region only — no filler rows.
6. Open that new warehouse, fill every field, save. All rows appear.
7. Try cutoff `25:00` (you may need to use the keyboard to bypass the picker, or test by tweaking the request via curl as in Task 2). Expect toast error.
8. Try sqft `-5`. Expect toast error.
9. Try email `nope`. Expect toast error.
10. Reload the page. All saved state persists.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "feat(desktop): edit warehouse detail fields in settings modal"
```

---

## Self-Review

Coverage against spec sections:
- Schema change → Task 1 ✓
- Backend GET / POST / PATCH with validation and per-field clearing → Task 2 ✓
- Seed data extension → Task 3 (not in spec but needed for `db:reset` correctness; called out in this plan)
- Frontend type → Task 4 ✓
- Deletion of `WAREHOUSE_EXTRAS`, header subtitle, capacity bar; conditional card rows; tz abbrev helper → Task 5 ✓
- Expanded modal with all new fields → Task 6 ✓
- Manual test plan (curl + browser) → embedded in tasks 1–6 ✓
- "Out of scope" items (operational toggles, structured address, capacity tracking, mobile parity) → untouched ✓

Type/name consistency: API camelCase keys (`managerPhone`, `managerEmail`, `cutoffLocal`) match the frontend type, the modal draft fields, and the card rendering. SQL column names (`manager_phone`, `manager_email`, `cutoff_local`) are mapped only in the backend route and seed script.

No placeholders or "TBD" steps; every code block is complete.
