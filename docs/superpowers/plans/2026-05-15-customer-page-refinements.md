# Customer Page Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the customer entity (structured contact + address, drop credit limit / payment terms), auto-hide archived customers, and reduce status to Active/Archived only.

**Architecture:** A single SQL migration reshapes the `customers` table and drops the `payment_terms` lookup table. Backend Hono routes (`customers`, `sellOrders`, `lookups`) and the seed script are updated to the new shape. The React Customers panel and the sell-order screens are updated to match. No new tables; the contact lives as flat columns on `customers`.

**Tech Stack:** PostgreSQL (raw SQL migrations via `postgres` driver), Hono + TypeScript backend, Vitest backend tests, React + TypeScript (Vite) frontend.

**Spec:** `docs/superpowers/specs/2026-05-15-customer-page-refinements-design.md`

---

## File Structure

- **Create** `apps/backend/migrations/0018_customer_contact_address.sql` — schema change.
- **Create** `apps/backend/tests/lookups.test.ts` — asserts `paymentTerms` gone.
- **Create** `apps/backend/tests/customers.test.ts` — asserts new customer shape.
- **Modify** `apps/backend/scripts/seed.mjs` — new customer columns; drop payment_terms seeding.
- **Modify** `apps/backend/scripts/migrate.mjs` — drop `payment_terms` from `--reset` list.
- **Modify** `apps/backend/src/routes/lookups.ts` — remove payment_terms query/field.
- **Modify** `apps/backend/src/routes/sellOrders.ts` — remove `customer_terms`.
- **Modify** `apps/backend/src/routes/customers.ts` — new contact/address fields.
- **Modify** `apps/frontend/src/lib/lookups.ts` — remove `paymentTerms`.
- **Modify** `apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx` — remove terms UI.
- **Modify** `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` — remove terms column/refs.
- **Modify** `apps/frontend/src/pages/desktop/DesktopSettings.tsx` — Customers panel rework.

Task order is dependency-driven: the migration + seed must land first (tests run all migrations + seed via `resetDb`), then the backend routes that query dropped columns, then the frontend.

---

## Task 1: Migration + seed + reset list

**Files:**
- Create: `apps/backend/migrations/0018_customer_contact_address.sql`
- Modify: `apps/backend/scripts/seed.mjs:585-602`
- Modify: `apps/backend/scripts/seed.mjs:483-490` (PAYMENT_TERMS block)
- Modify: `apps/backend/scripts/migrate.mjs:43`

- [ ] **Step 1: Create the migration file**

Create `apps/backend/migrations/0018_customer_contact_address.sql`:

```sql
-- 0018_customer_contact_address.sql
-- Structured contact + address on customers; drop credit_limit, terms,
-- and the now-unused payment_terms lookup table.

ALTER TABLE customers DROP COLUMN IF EXISTS credit_limit;
ALTER TABLE customers DROP COLUMN IF EXISTS terms;
ALTER TABLE customers DROP COLUMN IF EXISTS contact;          -- old email-only string
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS contact_name  TEXT;
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS address       TEXT;
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS country       TEXT;

DROP TABLE IF EXISTS payment_terms;
```

- [ ] **Step 2: Update the seed customers block**

In `apps/backend/scripts/seed.mjs`, replace the `customers` array and its INSERT (currently lines ~586-602) with:

```javascript
  const customers = [
    { name:'NorthBridge Data Centers', short:'NorthBridge',  contactName:'Dana Ortiz',   contactEmail:'ops@northbridge.io',       contactPhone:'+1-212-555-0147', address:'48 Hudson Yards, Floor 12\nNew York, NY 10001', country:'United States', region:'US-East',    tags:['hyperscaler','priority'] },
    { name:'Helios Cloud Pte Ltd',     short:'Helios Cloud', contactName:'Wei Lim',      contactEmail:'procurement@helios.sg',     contactPhone:'+65-6555-0192',   address:'1 Raffles Place, #20-01\nSingapore 048616',        country:'Singapore',     region:'APAC',       tags:['cloud'] },
    { name:'Verge Reseller Group',     short:'Verge',        contactName:'Maria Gomez',  contactEmail:'buy@vergegroup.com',        contactPhone:'+1-415-555-0173', address:'500 Howard St, Suite 300\nSan Francisco, CA 94105', country:'United States', region:'US-West',    tags:['reseller'] },
    { name:'Atlas Hosting GmbH',       short:'Atlas',        contactName:'Jonas Brandt', contactEmail:'einkauf@atlas-hosting.de',  contactPhone:'+49-30-5550-0188', address:'Friedrichstraße 68\n10117 Berlin',                  country:'Germany',       region:'EMEA',       tags:['hosting'] },
    { name:'Quantra Recyclers',        short:'Quantra',      contactName:'Priya Nair',   contactEmail:'deals@quantra.io',          contactPhone:'+1-312-555-0156', address:'233 S Wacker Dr, Floor 44\nChicago, IL 60606',      country:'United States', region:'US-Central', tags:['recycler'] },
    { name:'Lumen Refurb Co.',         short:'Lumen',        contactName:'Sam Patel',    contactEmail:'orders@lumenrefurb.com',    contactPhone:'+1-617-555-0121', address:'1 Boston Pl, Suite 2600\nBoston, MA 02108',        country:'United States', region:'US-East',    tags:['refurb'] },
  ];
  const customerRows = [];
  for (const c of customers) {
    const r = await sql`
      INSERT INTO customers (name, short_name, contact_name, contact_email, contact_phone, address, country, region, tags)
      VALUES (${c.name}, ${c.short}, ${c.contactName}, ${c.contactEmail}, ${c.contactPhone}, ${c.address}, ${c.country}, ${c.region}, ${c.tags})
      RETURNING id
    `;
    customerRows.push({ ...c, id: r[0].id });
  }
```

- [ ] **Step 3: Remove the PAYMENT_TERMS seed block**

In `apps/backend/scripts/seed.mjs`, delete these lines (currently ~483-490):

```javascript
  const PAYMENT_TERMS = ['Prepay', 'Net 7', 'Net 15', 'Net 30', 'Net 60'];
  await sql`DELETE FROM payment_terms`;
  for (let i = 0; i < PAYMENT_TERMS.length; i++) {
    await sql`
      INSERT INTO payment_terms (label, position)
      VALUES (${PAYMENT_TERMS[i]}, ${i})
    `;
  }
```

(Leave the surrounding `PRICE_SOURCES` block intact.)

- [ ] **Step 4: Update the migrate.mjs reset table list**

In `apps/backend/scripts/migrate.mjs` line ~43, remove `payment_terms` from the `DROP TABLE IF EXISTS` list. Change:

```javascript
        catalog_options, payment_terms, price_sources, sell_order_statuses,
```
to:
```javascript
        catalog_options, price_sources, sell_order_statuses,
```

- [ ] **Step 5: Run a full DB reset to verify migration + seed**

Run: `pnpm --filter recycle-erp-backend db:reset`
Expected: completes with no error; output ends with seed completion logs and no SQL error mentioning `terms`, `credit_limit`, `contact`, or `payment_terms`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/migrations/0018_customer_contact_address.sql apps/backend/scripts/seed.mjs apps/backend/scripts/migrate.mjs
git commit -m "feat(backend): migration for structured customer contact/address; drop terms, credit_limit, payment_terms

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend lookups route — drop paymentTerms

**Files:**
- Create: `apps/backend/tests/lookups.test.ts`
- Modify: `apps/backend/src/routes/lookups.ts:15-39`, `:46-58`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/lookups.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('GET /api/lookups', () => {
  beforeAll(async () => { await resetDb(); });

  it('returns lookup groups without paymentTerms', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{
      catalog: Record<string, string[]>;
      priceSources: unknown[];
      sellOrderStatuses: unknown[];
      paymentTerms?: unknown;
    }>('GET', '/api/lookups', undefined, token);

    expect(r.status).toBe(200);
    expect(r.body.priceSources).toBeInstanceOf(Array);
    expect(r.body.sellOrderStatuses).toBeInstanceOf(Array);
    expect(r.body).not.toHaveProperty('paymentTerms');
  });
});
```

Note: confirm the `api` helper signature by reading `apps/backend/tests/helpers/app.ts` and an existing caller (e.g. `apps/backend/tests/smoke.test.ts`); match the exact argument order used there for `(method, path, body, token)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- lookups`
Expected: FAIL — `paymentTerms` property still present (and/or 500 because the `payment_terms` table was dropped in Task 1).

- [ ] **Step 3: Remove the payment_terms query and field**

In `apps/backend/src/routes/lookups.ts`:

Replace the `Promise.all` destructuring + array (lines ~15-39) with:

```typescript
  const [catalogRows, sourceRows, statusRows] = await Promise.all([
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
  ]);
```

Then remove the `paymentTerms` line from the JSON response so it reads:

```typescript
  return c.json({
    catalog,
    priceSources: sourceRows.map(r => ({ id: r.id as string, label: r.label as string })),
    sellOrderStatuses: statusRows.map(r => ({
      id: r.id as string,
      label: r.label as string,
      short: r.short_label as string,
      tone: r.tone as string,
      needsMeta: r.needs_meta as boolean,
      position: r.position as number,
    })),
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter recycle-erp-backend test -- lookups`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/lookups.ts apps/backend/tests/lookups.test.ts
git commit -m "feat(backend): drop paymentTerms from /api/lookups

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Backend sellOrders route — drop customer_terms

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts:27`, `:42`, `:60`, `:63`, `:113`

- [ ] **Step 1: Remove `customer_terms` from the list query + response**

In `apps/backend/src/routes/sellOrders.ts` line ~27, change:

```typescript
      c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short, c.terms AS customer_terms,
```
to:
```typescript
      c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short,
```

Line ~42, change:
```typescript
      customer: { id: r.customer_id, name: r.customer_name, short: r.customer_short, terms: r.customer_terms },
```
to:
```typescript
      customer: { id: r.customer_id, name: r.customer_name, short: r.customer_short },
```

- [ ] **Step 2: Remove `customer_terms` from the detail query + type + response**

Line ~60, remove `customer_terms: string;` from the row type annotation (keep `customer_region: string;`).

Line ~63, change:
```typescript
           c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short, c.terms AS customer_terms, c.region AS customer_region
```
to:
```typescript
           c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short, c.region AS customer_region
```

Line ~113, change:
```typescript
      customer: { id: head.customer_id, name: head.customer_name, short: head.customer_short, terms: head.customer_terms, region: head.customer_region },
```
to:
```typescript
      customer: { id: head.customer_id, name: head.customer_name, short: head.customer_short, region: head.customer_region },
```

- [ ] **Step 3: Verify no `terms` references remain in the file**

Run: `grep -n "terms" apps/backend/src/routes/sellOrders.ts`
Expected: no output.

- [ ] **Step 4: Run the existing sell-orders tests + typecheck**

Run: `pnpm --filter recycle-erp-backend test -- sell-orders`
Expected: PASS (queries no longer reference the dropped `customers.terms` column).

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts
git commit -m "feat(backend): drop customer terms from sell-order responses

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Backend customers route — structured contact + address

**Files:**
- Create: `apps/backend/tests/customers.test.ts`
- Modify: `apps/backend/src/routes/customers.ts:11-31`, `:33-49`, `:51-73`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/customers.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('customers route — structured contact/address', () => {
  beforeAll(async () => { await resetDb(); });

  it('creates and reads a customer with the new fields', async () => {
    const { token } = await loginAs(ALEX);

    const created = await api<{ id: string }>('POST', '/api/customers', {
      name: 'Test Co',
      shortName: 'TestCo',
      contactName: 'Jane Doe',
      contactEmail: 'jane@test.co',
      contactPhone: '+1-555-0100',
      address: '1 Test St\nTestville',
      country: 'United States',
      region: 'US-East',
    }, token);
    expect(created.status).toBe(201);

    const list = await api<{ items: Array<Record<string, unknown>> }>(
      'GET', '/api/customers', undefined, token,
    );
    expect(list.status).toBe(200);
    const row = list.body.items.find(c => c.id === created.body.id)!;
    expect(row.contact_name).toBe('Jane Doe');
    expect(row.contact_email).toBe('jane@test.co');
    expect(row.contact_phone).toBe('+1-555-0100');
    expect(row.address).toBe('1 Test St\nTestville');
    expect(row.country).toBe('United States');
    expect(row).not.toHaveProperty('terms');
    expect(row).not.toHaveProperty('credit_limit');
    expect(row).not.toHaveProperty('contact');
  });

  it('patches contact fields', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api<{ items: Array<{ id: string; name: string }> }>(
      'GET', '/api/customers', undefined, token,
    );
    const target = list.body.items[0].id;

    const patched = await api('PATCH', `/api/customers/${target}`, {
      contactPhone: '+1-555-9999',
    }, token);
    expect(patched.status).toBe(200);

    const after = await api<{ items: Array<Record<string, unknown>> }>(
      'GET', '/api/customers', undefined, token,
    );
    const row = after.body.items.find(c => c.id === target)!;
    expect(row.contact_phone).toBe('+1-555-9999');
  });
});
```

Match the `api` helper argument order to existing tests (see `apps/backend/tests/sell-orders.test.ts` for POST/PATCH-with-token examples) before running.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- customers`
Expected: FAIL — route still inserts/selects `contact`/`terms`/`credit_limit`; new columns not returned.

- [ ] **Step 3: Update the GET query**

In `apps/backend/src/routes/customers.ts`, replace the SELECT column list (lines ~12-14) with:

```typescript
    SELECT c.id, c.name, c.short_name, c.contact_name, c.contact_email,
           c.contact_phone, c.address, c.country, c.region,
           c.tags, c.notes, c.active, c.created_at,
           COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS lifetime_revenue,
           COUNT(DISTINCT so.id)::int AS order_count,
           MAX(so.created_at)         AS last_order
```

(Leave the `FROM`, `LEFT JOIN`, `WHERE`, `GROUP BY`, `ORDER BY` clauses unchanged.)

- [ ] **Step 4: Update the POST handler**

Replace the POST body type + INSERT (lines ~36-48) with:

```typescript
  const body = (await c.req.json().catch(() => null)) as
    | { name: string; shortName?: string; contactName?: string; contactEmail?: string;
        contactPhone?: string; address?: string; country?: string; region?: string;
        tags?: string[]; notes?: string }
    | null;
  if (!body?.name) return c.json({ error: 'name is required' }, 400);

  const sql = getDb(c.env);
  const r = await sql`
    INSERT INTO customers (name, short_name, contact_name, contact_email, contact_phone, address, country, region, tags, notes)
    VALUES (${body.name}, ${body.shortName ?? null}, ${body.contactName ?? null},
            ${body.contactEmail ?? null}, ${body.contactPhone ?? null}, ${body.address ?? null},
            ${body.country ?? null}, ${body.region ?? null}, ${body.tags ?? []}, ${body.notes ?? null})
    RETURNING id
  `;
  return c.json({ id: r[0].id }, 201);
```

- [ ] **Step 5: Update the PATCH handler**

Replace the `UPDATE customers SET …` block (lines ~59-71) with:

```typescript
  await sql`
    UPDATE customers SET
      name          = COALESCE(${body.name as string ?? null}, name),
      short_name    = COALESCE(${body.shortName as string ?? null}, short_name),
      contact_name  = COALESCE(${body.contactName as string ?? null}, contact_name),
      contact_email = COALESCE(${body.contactEmail as string ?? null}, contact_email),
      contact_phone = COALESCE(${body.contactPhone as string ?? null}, contact_phone),
      address       = COALESCE(${body.address as string ?? null}, address),
      country       = COALESCE(${body.country as string ?? null}, country),
      region        = COALESCE(${body.region as string ?? null}, region),
      tags          = COALESCE(${body.tags as string[] ?? null}, tags),
      notes         = COALESCE(${body.notes as string ?? null}, notes),
      active        = COALESCE(${body.active as boolean ?? null}, active)
    WHERE id = ${id}
  `;
  return c.json({ ok: true });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter recycle-erp-backend test -- customers`
Expected: PASS.

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/customers.ts apps/backend/tests/customers.test.ts
git commit -m "feat(backend): structured contact + address on customers route

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend sell orders + lookups lib — remove terms

**Files:**
- Modify: `apps/frontend/src/lib/lookups.ts:33`, `:57`, `:81`, `:103`
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx:5`, `:26-32`, `:59`, `:86-91`, `:195-227`, `:511`
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx:31`, `:95`, `:229`, `:251`, `:432`, `:539`

- [ ] **Step 1: Remove `paymentTerms` from the lookups lib**

In `apps/frontend/src/lib/lookups.ts`:
- Delete the line `export const paymentTerms: string[] = [];`
- In the `LookupsResponse` type, delete the `paymentTerms: string[];` member.
- In `loadLookups`, delete the line `paymentTerms.splice(0, paymentTerms.length, ...data.paymentTerms);`
- In `resetLookups`, delete the line `paymentTerms.length = 0;`

- [ ] **Step 2: Remove the Payment terms UI from the sell-order draft**

In `apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx`:

- Line ~5: delete `import { paymentTerms } from '../../lib/lookups';`
- In the `Customer` type (lines ~26-32): delete the `terms: string;` member.
- Line ~59: delete `const [terms, setTerms] = useState<string>('Net 30');`
- In the customers-load effect (lines ~86-91): remove the `setTerms(r.items[0].terms);` line. The block becomes:

```typescript
        setCustomers(r.items);
        if (r.items.length && !customerId) {
          setCustomerId(r.items[0].id);
        }
```

- Replace the "Customer + terms" section (lines ~195-227) with a customer-only section:

```tsx
            {/* Customer */}
            <div className="so-section">
              <div className="so-section-head">
                <Icon name="user" size={14} /> Customer
              </div>
              <div>
                <label className="so-label">Customer</label>
                <CustomerPicker
                  customers={customers}
                  value={customerId}
                  onChange={(id) => { setCustomerId(id); }}
                  onCreated={(c) => { setCustomers((prev) => [...prev, c]); }}
                />
              </div>
            </div>
```

- Line ~511 (customer picker sub-line): change `{c.terms} · {c.region ?? '—'}` to `{c.region ?? '—'}`.

- [ ] **Step 3: Confirm `terms` is no longer used in the draft and that the save payload never sent it**

Run: `grep -n "terms" apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx`
Expected: no output. (If any line remains — e.g. a `terms` field in the save payload — remove it; the backend does not accept or store sell-order terms.)

- [ ] **Step 4: Remove `terms` from the sell-order list**

In `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`:

- Lines ~31 and ~95: in both `customer: { id: string; name: string; short: string; terms: string; region: string };` literals, delete `terms: string; ` so each reads `customer: { id: string; name: string; short: string; region: string };`
- Line ~229: delete the `<th>Terms</th>` header.
- Line ~251: delete the row cell `<td><span className="chip">{o.customer.terms}</span></td>`.
- Line ~432: change `{fmtDate(order.createdAt)} · {order.customer.region} · {order.customer.terms}` to `{fmtDate(order.createdAt)} · {order.customer.region}`.
- Line ~539: in the inline customer object passed to `CustomerPicker`, delete the `terms: order.customer.terms,` line.

- [ ] **Step 5: Confirm no `terms` references remain in the list**

Run: `grep -n "terms" apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`
Expected: no output.

- [ ] **Step 6: Frontend typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS (no remaining `paymentTerms` / `customer.terms` references; note Task 6 still pending — if the only errors are in `DesktopSettings.tsx`, that is expected and addressed next; there should be none here).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/lib/lookups.ts apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx apps/frontend/src/pages/desktop/DesktopSellOrders.tsx
git commit -m "feat(frontend): remove payment terms from sell-order screens + lookups lib

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend Customers panel rework

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx:20-25` (Customer type)
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx:1146-1522` (CustomersPanel + CustomerEditModal)

- [ ] **Step 1: Update the `Customer` type**

Replace the `Customer` type (lines ~20-25) with:

```typescript
type Customer = {
  id: string; name: string; short_name: string | null;
  contact_name: string | null; contact_email: string | null; contact_phone: string | null;
  address: string | null; country: string | null;
  region: string | null;
  tags: string[]; notes: string | null; active: boolean;
  lifetime_revenue: number; order_count: number;
};
```

- [ ] **Step 2: Reduce status to Active/Archived**

Replace lines ~1150-1166 (`CustomerStatus`, `STATUS_CHIP`, `deriveCustomerSeed`) with:

```typescript
type CustomerStatus = 'Active' | 'Archived';
const STATUS_CHIP: Record<CustomerStatus, 'pos' | 'muted'> = {
  Active: 'pos', Archived: 'muted',
};
function deriveCustomerSeed(c: Customer) {
  // Status is real (the `active` flag); outstanding + last-order remain
  // deterministic UI mocks derived from id until the backend tracks them.
  const n = [...c.id].reduce((s, ch) => s + ch.charCodeAt(0), 0);
  const r = (k: number) => ((n * (k + 1)) % 1000) / 1000;
  const status: CustomerStatus = c.active ? 'Active' : 'Archived';
  const outstanding = r(4) > 0.55 ? Math.round(r(5) * 18000) : 0;
  const lastDays = Math.round(1 + r(3) * 60);
  return { status, outstanding, lastDays };
}
```

- [ ] **Step 3: Default filter to Active; rework counts**

In `CustomersPanel`, change the `statusFilter` initial state (line ~1174) from `'all'` to `'Active'`:

```typescript
  const [statusFilter, setStatusFilter] = useState<'all' | CustomerStatus>('Active');
```

Replace the `counts` object (lines ~1210-1215) with:

```typescript
  const counts = {
    all: enriched.length,
    Active: enriched.filter(c => c.status === 'Active').length,
    Archived: enriched.filter(c => c.status === 'Archived').length,
  };
```

- [ ] **Step 4: Update the stat tile sub-text**

Replace the "Active accounts" `StatTile` (lines ~1232-1237) with:

```tsx
        <StatTile
          label="Active accounts"
          value={counts.Active}
          sub={`${counts.Archived} archived · ${enriched.length} total`}
          icon="user"
        />
```

- [ ] **Step 5: Replace the filter segmented control**

Replace the `seg` button list (lines ~1256-1265) with:

```tsx
          {([
            { v: 'Active',   label: 'Active',   count: counts.Active },
            { v: 'Archived', label: 'Archived', count: counts.Archived },
            { v: 'all',      label: 'All',      count: counts.all },
          ] as const).map(o => (
            <button key={o.v} className={statusFilter === o.v ? 'active' : ''} onClick={() => setStatusFilter(o.v)}>
              {o.label} <span style={{ opacity: 0.55, marginLeft: 4 }}>{o.count}</span>
            </button>
          ))}
```

- [ ] **Step 6: Update the search filter to match new contact fields**

In the `filtered` memo (lines ~1199-1208), replace the search block so it matches name, short_name, contact_name, contact_email:

```typescript
    if (search) {
      const q = search.toLowerCase();
      if (!c.name.toLowerCase().includes(q)
        && !(c.short_name ?? '').toLowerCase().includes(q)
        && !(c.contact_name ?? '').toLowerCase().includes(q)
        && !(c.contact_email ?? '').toLowerCase().includes(q)) return false;
    }
```

- [ ] **Step 7: Drop the Terms column and fix the contact sub-line**

In the table header (lines ~1284-1293), delete `<th>Terms</th>`.

In the table body, delete the Terms cell (line ~1323): `<td className="mono" style={{ fontSize: 13 }}>{c.terms}</td>`.

Change the contact sub-line under the customer name (line ~1317) from:
```tsx
                        <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{c.contact ?? '—'}</div>
```
to:
```tsx
                        <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{c.contact_name ?? c.contact_email ?? '—'}</div>
```

- [ ] **Step 8: Rework the create/edit modal**

Replace the modal body field grid + new-customer default. First, change the draft default (line ~1442) from `{ terms: 'Net 30', active: true, tags: [] }` to:

```typescript
  const [draft, setDraft] = useState<Partial<Customer>>(customer ?? { active: true, tags: [] });
```

Replace the `save` body object (lines ~1450-1454) with:

```typescript
      const body = {
        name: draft.name, shortName: draft.short_name,
        contactName: draft.contact_name, contactEmail: draft.contact_email,
        contactPhone: draft.contact_phone, address: draft.address,
        country: draft.country, region: draft.region,
        tags: draft.tags, notes: draft.notes, active: draft.active,
      };
```

Replace the `field-row` block (lines ~1469-1502, the Name…Credit-limit fields) with:

```tsx
          <div className="field-row">
            <div className="field">
              <label className="label">Name</label>
              <input className="input" value={String(draft.name ?? '')} onChange={e => set('name', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Short name</label>
              <input className="input" value={String(draft.short_name ?? '')} onChange={e => set('short_name', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Region</label>
              <input className="input" value={String(draft.region ?? '')} onChange={e => set('region', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Country</label>
              <input className="input" value={String(draft.country ?? '')} onChange={e => set('country', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Contact name</label>
              <input className="input" value={String(draft.contact_name ?? '')} onChange={e => set('contact_name', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Contact email</label>
              <input className="input" value={String(draft.contact_email ?? '')} onChange={e => set('contact_email', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Contact phone</label>
              <input className="input" value={String(draft.contact_phone ?? '')} onChange={e => set('contact_phone', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="label">Address</label>
            <textarea className="input" rows={2} value={String(draft.address ?? '')} onChange={e => set('address', e.target.value)} />
          </div>
```

(Leave the Notes textarea and Active toggle that follow unchanged.)

- [ ] **Step 9: Confirm no stale field references remain**

Run: `grep -n "\.terms\|credit_limit\|\.contact\b\|'On hold'\|'Lead'" apps/frontend/src/pages/desktop/DesktopSettings.tsx`
Expected: no output.

- [ ] **Step 10: Frontend typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "feat(frontend): customers panel — structured contact/address, Active/Archived only, auto-hide archived

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Backend full test suite**

Run: `pnpm --filter recycle-erp-backend test`
Expected: all suites PASS (including new `lookups.test.ts`, `customers.test.ts`, and existing `sell-orders.test.ts`).

- [ ] **Step 2: Backend typecheck**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: PASS.

- [ ] **Step 3: Frontend typecheck + build**

Run: `pnpm --filter recycle-erp-frontend build`
Expected: PASS (tsc -b + vite build, no errors).

- [ ] **Step 4: Clean DB reset**

Run: `pnpm --filter recycle-erp-backend db:reset`
Expected: completes with no SQL error.

- [ ] **Step 5: Repo-wide leftover scan**

Run: `grep -rn "paymentTerms\|payment_terms\|credit_limit\|creditLimit" apps/backend/src apps/frontend/src apps/backend/scripts`
Expected: no output (the only `customers.terms` / `payment_terms` mentions allowed are inside historical migration files `0002`/`0006`, which must not be edited).

- [ ] **Step 6: Manual smoke (if a dev server is run)**

Confirm: Customers panel opens defaulting to **Active** (archived hidden); Archived/All toggles work; Add/Edit modal shows Contact name/email/phone, Address, Country and round-trips a save; the sell-order draft and list render with no Payment terms UI and no console errors.

- [ ] **Step 7: Final commit (only if Step 1-6 surfaced fixes)**

```bash
git add -A
git commit -m "fix: address verification findings for customer page refinements

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** (1) auto-hide archived → Task 6 Step 3/5; (2) remove On hold/Lead → Task 6 Step 2; (3) add address → Tasks 1,4,6; (4) remove credit limit → Tasks 1,4,6; (5) structured contact → Tasks 1,4,6; (6) remove terms → Tasks 1,3,4,5; (extra) remove payment_terms table/lookup → Tasks 1,2,5. All covered.
- **Type consistency:** backend field names `contact_name/contact_email/contact_phone/address/country` (snake_case in SQL + GET response) ↔ request body camelCase `contactName/contactEmail/contactPhone/address/country` ↔ frontend `Customer` snake_case, save payload camelCase — consistent across Tasks 1, 4, 6.
- **Line numbers** are approximate ("~") and will drift as edits land; each edit step quotes the exact current code to anchor the change, and each task ends with a `grep` confirmation.
