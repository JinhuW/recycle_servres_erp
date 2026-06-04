# Customer-less ("general") Vendor Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single shareable vendor portal link that is not tied to any customer; the customer is chosen by a manager when a resulting bid is promoted to a sell order.

**Architecture:** Drop `NOT NULL` on `vendor_links.customer_id` and `vendor_bids.customer_id` (migration 0064, guarded by a partial unique index so only one active general link exists). A new `POST /api/customers/vendor-links` mints/rotates the general link; the listing endpoint returns it under a `general` field. The public portal greets generically when there's no customer. Promote requires the manager to pick a customer when the bid is unattributed, writing it to the sell order and back onto the bid.

**Tech Stack:** Hono + postgres.js backend (Node 22), React frontend, Vitest integration tests against real Postgres.

---

## Spec

`docs/superpowers/specs/2026-06-04-customerless-vendor-link-design.md`

## Conventions reminder

- Run a single backend test file with: `cd apps/backend && npx vitest run tests/<file>.test.ts` (the pnpm filter form drops the path and runs the whole suite).
- Backend tests need Postgres on `127.0.0.1:5432` (the docker-compose override provides it).
- Migrations are plain SQL, numbered `NNNN_…sql`, run on startup. Add the next number (head is `0063`); never edit a deployed one.
- All mutating frontend calls go through `lib/api.ts`. Translatable strings go through `useT()`.

## File map

- Create `apps/backend/migrations/0064_vendor_link_optional_customer.sql` — drop NOT NULL + partial unique index.
- Modify `apps/backend/src/routes/customers.ts` — new general-link POST; `general` field on the listing.
- Modify `apps/backend/src/routes/vendorPublic.ts` — nullable `customer_id`; `/me` generic when null.
- Modify `apps/backend/src/routes/vendorBids.ts` — LEFT JOIN customers; promote accepts/validates `customerId`, back-fills bid.
- Modify `apps/frontend/src/VendorApp.tsx` — nullable `me.customer` header.
- Modify `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx` — general-link section; "General" badge; promote customer picker.
- Modify `apps/frontend/src/lib/i18n.tsx` — new EN + ZH keys.
- Create `apps/backend/tests/vendor-general-link.test.ts` — full backend coverage of the new path.

---

## Task 1: Migration — make customer optional + one-active-general guard

**Files:**
- Create: `apps/backend/migrations/0064_vendor_link_optional_customer.sql`

- [ ] **Step 1: Write the migration**

```sql
-- General (customer-less) vendor links: one shareable URL not bound to a
-- customer. The customer is assigned by a manager when a resulting bid is
-- promoted to a sell order.

ALTER TABLE vendor_links ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE vendor_bids  ALTER COLUMN customer_id DROP NOT NULL;

-- At most one ACTIVE general link at a time (mirrors the per-customer
-- rotate-on-regenerate pattern). Indexes a constant for every active
-- customer-less row, so a second one violates uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_links_one_active_general
  ON vendor_links ((customer_id IS NULL))
  WHERE customer_id IS NULL AND active = TRUE;
```

- [ ] **Step 2: Run migrations and verify they apply**

Run: `cd apps/backend && node scripts/migrate.mjs`
Expected: output lists `0064_vendor_link_optional_customer.sql` as applied, no error. (Re-running is a no-op — it's recorded in `_migration_ledger`.)

- [ ] **Step 3: Commit**

```bash
git add apps/backend/migrations/0064_vendor_link_optional_customer.sql
git commit -m "feat(vendor): migration — optional customer on vendor links/bids"
```

---

## Task 2: Backend — mint/rotate the general link

**Files:**
- Modify: `apps/backend/src/routes/customers.ts`
- Test: `apps/backend/tests/vendor-general-link.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/vendor-general-link.test.ts`:

```ts
import { beforeEach, describe, it, expect } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

describe('vendor general (customer-less) links', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('mints a customer-less link and rotates the prior one', async () => {
    const { token: mgr } = await loginAs(ALEX);

    const first = await api<{ id: string; token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    expect(first.status).toBe(201);
    expect(first.body.token).toBeTruthy();

    const sql = getTestDb();
    const row1 = (await sql`
      SELECT customer_id, active FROM vendor_links WHERE id = ${first.body.id}
    `)[0];
    expect(row1.customer_id).toBeNull();
    expect(row1.active).toBe(true);

    // Regenerate → prior general link deactivated, exactly one active.
    const second = await api<{ id: string; token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    expect(second.status).toBe(201);

    const activeGeneral = await sql`
      SELECT id FROM vendor_links WHERE customer_id IS NULL AND active = TRUE
    `;
    expect(activeGeneral.length).toBe(1);
    expect(activeGeneral[0].id).toBe(second.body.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: FAIL — `POST /api/customers/vendor-links` returns 404 (route not defined yet).

- [ ] **Step 3: Add the route**

In `apps/backend/src/routes/customers.ts`, add this handler immediately AFTER the `customers.get('/vendor-links', …)` handler (so both literal `/vendor-links` routes sit together, before the `/:id/vendor-link` and `/:id` routes):

```ts
// Mint (or rotate) the single active GENERAL vendor link — a public bid URL
// not bound to any customer. Regenerating deactivates the prior general link
// so a leaked token can be rotated (mirrors the per-customer endpoint).
customers.post('/vendor-links', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);

  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const row = (await sql<{ id: string; token: string }[]>`
    WITH deact AS (
      UPDATE vendor_links SET active = FALSE
      WHERE customer_id IS NULL AND active = TRUE
    )
    INSERT INTO vendor_links (customer_id, token, created_by)
    VALUES (NULL, ${token}, ${u.id})
    RETURNING id, token
  `)[0];
  return c.json({ id: row.id, token: row.token }, 201);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/customers.ts apps/backend/tests/vendor-general-link.test.ts
git commit -m "feat(vendor): endpoint to mint/rotate the general vendor link"
```

---

## Task 3: Backend — expose the general link in the listing

**Files:**
- Modify: `apps/backend/src/routes/customers.ts`
- Test: `apps/backend/tests/vendor-general-link.test.ts`

- [ ] **Step 1: Add the failing test**

Append this `it` block inside the existing `describe` in `apps/backend/tests/vendor-general-link.test.ts`:

```ts
  it('returns the general link under `general`, absent from per-customer items', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const cust = await api<{ id: string }>('POST', '/api/customers', {
      token: mgr, body: { name: 'Per-Cust Co' },
    });
    await api('POST', `/api/customers/${cust.body.id}/vendor-link`, { token: mgr });
    const gen = await api<{ id: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });

    const list = await api<{
      items: { customerId: string; link: { id: string } | null }[];
      general: { id: string; token: string; bidCount: number } | null;
    }>('GET', '/api/customers/vendor-links', { token: mgr });

    expect(list.body.general).not.toBeNull();
    expect(list.body.general!.id).toBe(gen.body.id);
    expect(list.body.general!.bidCount).toBe(0);
    // The general link must not appear as a per-customer row.
    expect(list.body.items.some(i => i.link?.id === gen.body.id)).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: FAIL — `general` is `undefined` (assertion `not.toBeNull()` fails).

- [ ] **Step 3: Add the `general` field to the listing**

In `apps/backend/src/routes/customers.ts`, in the `customers.get('/vendor-links', …)` handler, after the existing `rows` query and before the `return c.json({…})`, add the general-link lookup:

```ts
  const general = (await sql<{
    id: string; token: string; created_at: string;
    last_seen_at: string | null; bid_count: number;
  }[]>`
    SELECT vl.id, vl.token, vl.created_at, vl.last_seen_at,
           COALESCE((SELECT COUNT(*)::int FROM vendor_bids vb
                       WHERE vb.vendor_link_id = vl.id), 0) AS bid_count
      FROM vendor_links vl
     WHERE vl.customer_id IS NULL AND vl.active = TRUE
     ORDER BY vl.created_at DESC
     LIMIT 1
  `)[0];
```

Then change the `return c.json({ items: … })` to include `general`:

```ts
  return c.json({
    items: rows.map(r => ({
      customerId: r.customer_id,
      customerName: r.customer_name,
      customerShort: r.customer_short,
      region: r.region,
      active: r.active,
      link: r.link_id ? {
        id: r.link_id, token: r.token!,
        createdAt: r.created_at, lastSeenAt: r.last_seen_at,
        bidCount: r.bid_count,
      } : null,
    })),
    general: general ? {
      id: general.id, token: general.token,
      createdAt: general.created_at, lastSeenAt: general.last_seen_at,
      bidCount: general.bid_count,
    } : null,
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: PASS (both `it` blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/customers.ts apps/backend/tests/vendor-general-link.test.ts
git commit -m "feat(vendor): expose general link in vendor-links listing"
```

---

## Task 4: Backend — public portal handles a customer-less link

**Files:**
- Modify: `apps/backend/src/routes/vendorPublic.ts`
- Test: `apps/backend/tests/vendor-general-link.test.ts`

- [ ] **Step 1: Add the failing test**

Append inside the existing `describe`:

```ts
  it('portal /me is generic and bids store a null customer for a general link', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const gen = await api<{ token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    const t = gen.body.token;

    const me = await api<{ customer: { name: string } | null; label: string | null }>(
      'GET', `/api/public/vendor/${t}/me`);
    expect(me.status).toBe(200);
    expect(me.body.customer).toBeNull();

    const inv = await api<{ items: { id: string; qty: number }[] }>(
      'GET', '/api/inventory?status=Done', { token: mgr });
    const line = inv.body.items.find(i => i.qty >= 1)!;

    const submit = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${t}/bids`, {
        body: { contactName: 'Anon Vendor', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
      });
    expect(submit.status).toBe(201);

    const sql = getTestDb();
    const bid = (await sql`
      SELECT customer_id FROM vendor_bids WHERE id = ${submit.body.bidId}
    `)[0];
    expect(bid.customer_id).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: FAIL — `/me` returns 404 (current code looks up a customer and 404s when none).

- [ ] **Step 3: Make `loadLink` + `/me` null-safe**

In `apps/backend/src/routes/vendorPublic.ts`, change the `Link` type's `customer_id` to nullable:

```ts
type Link = { id: string; customer_id: string | null; label: string | null };
```

Replace the `vendorPublic.get('/:token/me', …)` handler with:

```ts
vendorPublic.get('/:token/me', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);
  if (!link.customer_id) {
    // General link — no customer to greet with.
    return c.json({ customer: null, label: link.label });
  }
  const cust = (await sql<{ name: string; short_name: string | null }[]>`
    SELECT name, short_name FROM customers WHERE id = ${link.customer_id} LIMIT 1
  `)[0];
  if (!cust) return c.json({ error: 'Not found' }, 404);
  return c.json({ customer: { name: cust.name, short: cust.short_name }, label: link.label });
});
```

The bid `INSERT` already passes `${link.customer_id}`; with the column nullable it now stores `NULL` for a general link. No other change in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/vendorPublic.ts apps/backend/tests/vendor-general-link.test.ts
git commit -m "feat(vendor): public portal handles customer-less link"
```

---

## Task 5: Backend — bid list/detail tolerate null customer

**Files:**
- Modify: `apps/backend/src/routes/vendorBids.ts`
- Test: `apps/backend/tests/vendor-general-link.test.ts`

- [ ] **Step 1: Add the failing test**

Append inside the existing `describe`:

```ts
  it('bid list and detail return null customer for a general-link bid', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const gen = await api<{ token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    const inv = await api<{ items: { id: string; qty: number }[] }>(
      'GET', '/api/inventory?status=Done', { token: mgr });
    const line = inv.body.items.find(i => i.qty >= 1)!;
    const submit = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${gen.body.token}/bids`, {
        body: { contactName: 'Anon', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
      });

    const list = await api<{ items: { id: string; customer_name: string | null }[] }>(
      'GET', '/api/vendor-bids', { token: mgr });
    const listed = list.body.items.find(b => b.id === submit.body.bidId)!;
    expect(listed.customer_name).toBeNull();

    const detail = await api<{ bid: { customer_id: string | null; customer_name: string | null } }>(
      'GET', `/api/vendor-bids/${submit.body.bidId}`, { token: mgr });
    expect(detail.body.bid.customer_id).toBeNull();
    expect(detail.body.bid.customer_name).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: FAIL — the inner `JOIN customers` drops the null-customer bid, so `find(...)` is `undefined` and the test throws.

- [ ] **Step 3: Switch both joins to LEFT JOIN**

In `apps/backend/src/routes/vendorBids.ts`:

In the `vendorBids.get('/', …)` query, change:

```ts
    FROM vendor_bids b
    JOIN customers cu ON cu.id = b.customer_id
```

to:

```ts
    FROM vendor_bids b
    LEFT JOIN customers cu ON cu.id = b.customer_id
```

In the `vendorBids.get('/:id', …)` query, change:

```ts
    FROM vendor_bids b JOIN customers cu ON cu.id = b.customer_id
```

to:

```ts
    FROM vendor_bids b LEFT JOIN customers cu ON cu.id = b.customer_id
```

(The selected `cu.name`/`cu.id` already come back as `null` under a LEFT JOIN; the response types are widened on the frontend in Task 7.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/vendorBids.ts apps/backend/tests/vendor-general-link.test.ts
git commit -m "feat(vendor): bid list/detail tolerate null customer"
```

---

## Task 6: Backend — promote picks a customer for unattributed bids

**Files:**
- Modify: `apps/backend/src/routes/vendorBids.ts`
- Test: `apps/backend/tests/vendor-general-link.test.ts`

- [ ] **Step 1: Add the failing tests**

Append inside the existing `describe`. This helper accepts a line so the bid has an accepted, promotable line:

```ts
  async function generalBidReadyToPromote(mgr: string): Promise<string> {
    const gen = await api<{ token: string }>(
      'POST', '/api/customers/vendor-links', { token: mgr });
    const inv = await api<{ items: { id: string; qty: number }[] }>(
      'GET', '/api/inventory?status=Done', { token: mgr });
    const line = inv.body.items.find(i => i.qty >= 1)!;
    const submit = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${gen.body.token}/bids`, {
        body: { contactName: 'Anon', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
      });
    const detail = await api<{ bid: { lines: { id: string }[] } }>(
      'GET', `/api/vendor-bids/${submit.body.bidId}`, { token: mgr });
    await api('POST', `/api/vendor-bids/${submit.body.bidId}/decide`, {
      token: mgr,
      body: { lines: [{ lineId: detail.body.bid.lines[0].id, decision: 'accepted' }] },
    });
    return submit.body.bidId;
  }

  it('promote of an unattributed bid requires a customerId', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const bidId = await generalBidReadyToPromote(mgr);

    const noCust = await api('POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(noCust.status).toBe(400);

    const badCust = await api('POST', `/api/vendor-bids/${bidId}/promote`, {
      token: mgr, body: { customerId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(badCust.status).toBe(400);
  });

  it('promote with a valid customerId creates the SO and back-fills the bid', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const bidId = await generalBidReadyToPromote(mgr);
    const cust = await api<{ id: string }>('POST', '/api/customers', {
      token: mgr, body: { name: 'Chosen At Promote' },
    });

    const ok = await api<{ sellOrderId: string }>(
      'POST', `/api/vendor-bids/${bidId}/promote`, {
        token: mgr, body: { customerId: cust.body.id },
      });
    expect(ok.status).toBe(201);

    const sql = getTestDb();
    const so = (await sql`
      SELECT customer_id FROM sell_orders WHERE id = ${ok.body.sellOrderId}
    `)[0];
    expect(so.customer_id).toBe(cust.body.id);
    const bid = (await sql`
      SELECT customer_id FROM vendor_bids WHERE id = ${bidId}
    `)[0];
    expect(bid.customer_id).toBe(cust.body.id);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: FAIL — promote inserts `NULL` into `sell_orders.customer_id`, violating its NOT NULL constraint (500), so the 400/201 assertions fail.

- [ ] **Step 3: Resolve + validate the customer in promote**

In `apps/backend/src/routes/vendorBids.ts`, in `vendorBids.post('/:id/promote', …)`, read the optional body BEFORE the transaction (just after `const id = c.req.param('id');`):

```ts
  const body = (await c.req.json().catch(() => null)) as { customerId?: string } | null;
  const bodyCustomerId = typeof body?.customerId === 'string' ? body.customerId : null;
```

Inside `sql.begin`, replace the head lookup + immediate use. After:

```ts
    const head = (await tx<{ customer_id: string; currency_code: SupportedCurrency }[]>`
      SELECT customer_id, currency_code FROM vendor_bids WHERE id=${id} LIMIT 1`)[0];
    if (!head) { outcome = { code: 400, msg: 'bid not found' }; return; }
```

change `head`'s type to allow null and resolve the effective customer:

```ts
    const head = (await tx<{ customer_id: string | null; currency_code: SupportedCurrency }[]>`
      SELECT customer_id, currency_code FROM vendor_bids WHERE id=${id} LIMIT 1`)[0];
    if (!head) { outcome = { code: 400, msg: 'bid not found' }; return; }

    // A bid from a general (customer-less) link carries no customer. The
    // manager must choose one at promote time — sell_orders.customer_id is
    // NOT NULL. Persist the choice back onto the bid for attribution.
    let customerId = head.customer_id;
    if (!customerId) {
      if (!bodyCustomerId) { outcome = { code: 400, msg: 'customer required' }; return; }
      const exists = (await tx<{ id: string }[]>`
        SELECT id FROM customers WHERE id = ${bodyCustomerId} LIMIT 1`)[0];
      if (!exists) { outcome = { code: 400, msg: 'customer not found' }; return; }
      customerId = bodyCustomerId;
      await tx`UPDATE vendor_bids SET customer_id = ${customerId} WHERE id = ${id}`;
    }
```

Then replace every later use of `head.customer_id` in this handler with `customerId`:
- the `INSERT INTO sell_orders (... customer_id ...) VALUES (${sellId}, ${head.customer_id}, …)` → `${customerId}`.
- the `writeSellOrderEvent(... customerId: head.customer_id …)` → `customerId: customerId`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Regression — existing vendor suites still pass**

Run: `cd apps/backend && npx vitest run tests/vendor-bids.test.ts tests/vendor-promote-validation.test.ts tests/vendor-bid-promote-fx.test.ts`
Expected: PASS. (Per-customer promote ignores the new body and uses `head.customer_id`.)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/vendorBids.ts apps/backend/tests/vendor-general-link.test.ts
git commit -m "feat(vendor): promote picks/validates a customer for general-link bids"
```

---

## Task 7: Frontend — i18n keys

**Files:**
- Modify: `apps/frontend/src/lib/i18n.tsx`

- [ ] **Step 1: Add the English keys**

In `apps/frontend/src/lib/i18n.tsx`, in the English (`en`) block, immediately after `vendorLinkRevoked: …` (around line 237), add:

```ts
    vendorPortal: 'Vendor portal',
    vbGeneralLink: 'General link',
    vendorLinksGeneralTitle: 'General link',
    vendorLinksGeneralSub: 'One shareable URL not tied to a customer. Anyone with the link can submit offers; you pick the customer when promoting their bid.',
    vendorLinksGeneralGenerate: 'Generate general link',
    vendorLinksGeneralRegenerate: 'Regenerate',
    vendorLinksGeneralRevokeConfirm: 'Revoke the general vendor link? Existing in-flight bids stay, but no new bids can be submitted with this URL.',
    vendorLinksGeneralGenerated: 'Generated general vendor link',
    vendorLinksGeneralRevoked: 'Revoked the general vendor link',
    vbPromotePickCustomer: 'Pick a customer to promote this bid',
```

- [ ] **Step 2: Add the matching Chinese keys**

In the Chinese (`zh`) block, immediately after `vendorLinkRevoked: …` (around line 1704; find the same key you edited above), add:

```ts
    vendorPortal: '供应商门户',
    vbGeneralLink: '通用链接',
    vendorLinksGeneralTitle: '通用链接',
    vendorLinksGeneralSub: '一个不绑定客户的可共享网址。任何持有链接的人都可提交报价；提升其报价时再选择客户。',
    vendorLinksGeneralGenerate: '生成通用链接',
    vendorLinksGeneralRegenerate: '重新生成',
    vendorLinksGeneralRevokeConfirm: '撤销通用供应商链接？已提交的报价保留，但该网址将无法再提交新报价。',
    vendorLinksGeneralGenerated: '已生成通用供应商链接',
    vendorLinksGeneralRevoked: '已撤销通用供应商链接',
    vbPromotePickCustomer: '选择客户以提升此报价',
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/frontend && npx tsc --noEmit`
Expected: no errors (keys are plain additions).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/i18n.tsx
git commit -m "feat(vendor): i18n keys for general vendor links (EN+ZH)"
```

---

## Task 8: Frontend — portal greets generically when there's no customer

**Files:**
- Modify: `apps/frontend/src/VendorApp.tsx`

- [ ] **Step 1: Widen the `me` type**

In `apps/frontend/src/VendorApp.tsx`, change the `me` field type (around line 138) from:

```ts
  me: { customer: { name: string }; label: string | null } | null;
```

to:

```ts
  me: { customer: { name: string } | null; label: string | null } | null;
```

- [ ] **Step 2: Update the mobile header subtitle**

Around line 463, replace:

```tsx
        sub={me ? `${t('vendorSharedWith')} · ${me.customer.name}` : '…'}
```

with:

```tsx
        sub={me
          ? (me.customer
              ? `${t('vendorSharedWith')} · ${me.customer.name}`
              : (me.label ?? t('vendorPortal')))
          : '…'}
```

- [ ] **Step 3: Update the desktop header subtitle**

Around line 844, replace:

```tsx
              {me ? `${t('vendorSharedWith')} · ${me.customer.name}` : '…'}
```

with:

```tsx
              {me
                ? (me.customer
                    ? `${t('vendorSharedWith')} · ${me.customer.name}`
                    : (me.label ?? t('vendorPortal')))
                : '…'}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/frontend && npx tsc --noEmit`
Expected: no errors. (If `tsc` flags any other `me.customer.name` access without a null guard, add the same `me.customer ?` guard there.)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/VendorApp.tsx
git commit -m "feat(vendor): portal greets generically for customer-less links"
```

---

## Task 9: Frontend — "General" badge on bids with no customer

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx`

- [ ] **Step 1: Widen the bid types**

In `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx`:

In `type VbSummary` change `customer_name: string;` to `customer_name: string | null;`.

In `type VbDetail` change `customer_id: string;` and `customer_name: string;` to `customer_id: string | null;` and `customer_name: string | null;`.

- [ ] **Step 2: Render a "General" badge in the bid list**

In the list table body (around line 206), replace:

```tsx
                  <td>
                    <div style={{ fontWeight: 500 }}>{b.customer_name}</div>
                    {b.customer_short && (
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{b.customer_short}</div>
                    )}
                  </td>
```

with:

```tsx
                  <td>
                    {b.customer_name ? (
                      <>
                        <div style={{ fontWeight: 500 }}>{b.customer_name}</div>
                        {b.customer_short && (
                          <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{b.customer_short}</div>
                        )}
                      </>
                    ) : (
                      <span className="chip dot muted">{t('vbGeneralLink')}</span>
                    )}
                  </td>
```

- [ ] **Step 3: Render a fallback title in the detail header**

In `VendorBidDetail`, around line 442, replace:

```tsx
                <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>{bid.customer_name}</h2>
```

with:

```tsx
                <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>
                  {bid.customer_name ?? t('vbGeneralLink')}
                </h2>
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopVendorBids.tsx
git commit -m "feat(vendor): show General badge on customer-less bids"
```

---

## Task 10: Frontend — promote-time customer picker for unattributed bids

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx`

- [ ] **Step 1: Import the picker + customer type**

At the top of `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx`, add:

```tsx
import { CustomerPicker, type Customer } from './DesktopSellOrderDraft';
```

- [ ] **Step 2: Load customers + track the choice in `VendorBidDetail`**

Inside `VendorBidDetail`, alongside the other `useState` hooks (near `const [promoting, setPromoting] = useState(false);`), add:

```tsx
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [promoteCustomerId, setPromoteCustomerId] = useState('');
  const needsCustomer = !!bid && !bid.customer_id;
```

Add an effect to fetch customers only when needed (after the `fetchBid` effect):

```tsx
  useEffect(() => {
    if (!needsCustomer) return;
    let alive = true;
    api.get<{ items: Customer[] }>('/api/customers')
      .then(r => { if (alive) setCustomers(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [needsCustomer]);
```

- [ ] **Step 3: Send the chosen customer on promote**

In the `promote` function, change the POST call from:

```tsx
      const r = await api.post<{ sellOrderId: string }>(`/api/vendor-bids/${bid.id}/promote`, {});
```

to:

```tsx
      const r = await api.post<{ sellOrderId: string }>(
        `/api/vendor-bids/${bid.id}/promote`,
        needsCustomer ? { customerId: promoteCustomerId } : {},
      );
```

- [ ] **Step 4: Render the picker in the footer + gate the Promote button**

In the footer (around line 581), inside the `<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>`, add the picker BEFORE the existing buttons:

```tsx
              {needsCustomer && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {t('vbPromotePickCustomer')}
                  </span>
                  <CustomerPicker
                    customers={customers}
                    value={promoteCustomerId}
                    onChange={setPromoteCustomerId}
                    onCreated={c => setCustomers(prev => [...prev, c])}
                  />
                </div>
              )}
```

Then change the Promote button's `disabled` prop from:

```tsx
                disabled={promoting || dirty || persistedPromotable === 0}
```

to:

```tsx
                disabled={promoting || dirty || persistedPromotable === 0 || (needsCustomer && !promoteCustomerId)}
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopVendorBids.tsx
git commit -m "feat(vendor): promote-time customer picker for general-link bids"
```

---

## Task 11: Frontend — General-link section in the links manager

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopVendorBids.tsx`

- [ ] **Step 1: Add the `general` shape to the loaded data**

In `VendorLinksManager`, add a type for the general link near `type VendorLinkRow` (top of file):

```tsx
type GeneralLink = {
  id: string;
  token: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  bidCount: number;
};
```

Add state and update `reload` to capture `general`. Replace:

```tsx
  const reload = () => api.get<{ items: VendorLinkRow[] }>('/api/customers/vendor-links')
    .then(r => setRows(r.items))
    .catch(e => onToast?.(e instanceof Error ? e.message : 'Failed to load vendor links', 'error'))
    .finally(() => setLoaded(true));
```

with:

```tsx
  const [general, setGeneral] = useState<GeneralLink | null>(null);
  const reload = () => api.get<{ items: VendorLinkRow[]; general: GeneralLink | null }>('/api/customers/vendor-links')
    .then(r => { setRows(r.items); setGeneral(r.general); })
    .catch(e => onToast?.(e instanceof Error ? e.message : 'Failed to load vendor links', 'error'))
    .finally(() => setLoaded(true));
```

- [ ] **Step 2: Add generate/revoke handlers for the general link**

Inside `VendorLinksManager`, after the existing `copy` function, add:

```tsx
  const generateGeneral = async () => {
    setBusyId('__general__');
    try {
      await api.post('/api/customers/vendor-links', {});
      await reload();
      onToast?.(t('vendorLinksGeneralGenerated'), 'success');
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Failed to generate general link', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const revokeGeneral = async () => {
    if (!general) return;
    if (!window.confirm(t('vendorLinksGeneralRevokeConfirm'))) return;
    setBusyId('__general__');
    try {
      await api.patch(`/api/customers/vendor-link/${general.id}`, { active: false });
      await reload();
      onToast?.(t('vendorLinksGeneralRevoked'), 'success');
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Failed to revoke general link', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const copyGeneral = () => {
    if (!general) return;
    shareOrCopy({
      url: urlFor(general.token),
      title: t('vendorLink'),
      copiedMsg: t('vendorLinkCopied'),
      failedMsg: t('orderIdCopyFailed'),
      onToast,
    });
  };
```

- [ ] **Step 3: Render the General-link card above the per-customer table**

In the JSX, insert this block immediately after the stats row's closing `</div>` (the `div` containing `VlStat`s, around line 756) and BEFORE the `<div style={{ padding: '8px 0 0', … }}>` table container:

```tsx
        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{t('vendorLinksGeneralTitle')}</div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 2, maxWidth: 560 }}>
                {t('vendorLinksGeneralSub')}
              </div>
              {general && (
                <div className="vl-url" title={urlFor(general.token)} style={{ marginTop: 10 }}>
                  <span className="vl-dot" aria-hidden />
                  <span className="vl-url-text mono">{urlFor(general.token)}</span>
                </div>
              )}
              {general && (
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 6, display: 'flex', gap: 12 }}>
                  <span>{t('vendorLinksColBids')}: {general.bidCount}</span>
                  <span>
                    {t('vendorLinksColLastSeen')}: {general.lastSeenAt
                      ? relTime(general.lastSeenAt, locale)
                      : t('vendorLinksNeverSeen')}
                  </span>
                </div>
              )}
            </div>
            <div style={{ display: 'inline-flex', gap: 4, whiteSpace: 'nowrap' }}>
              {general ? (
                <>
                  <button className="btn sm" disabled={busyId === '__general__'} onClick={copyGeneral}>
                    <Icon name="paperclip" size={12} /> {t('vendorLinkCopy')}
                  </button>
                  <button className="btn sm" disabled={busyId === '__general__'} onClick={generateGeneral}>
                    {t('vendorLinksGeneralRegenerate')}
                  </button>
                  <button className="btn sm" disabled={busyId === '__general__'} onClick={revokeGeneral} style={{ color: 'var(--neg)' }}>
                    {t('vendorLinkRevoke')}
                  </button>
                </>
              ) : (
                <button className="btn sm accent" disabled={busyId === '__general__'} onClick={generateGeneral}>
                  <Icon name="globe" size={12} /> {t('vendorLinksGeneralGenerate')}
                </button>
              )}
            </div>
          </div>
        </div>
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopVendorBids.tsx
git commit -m "feat(vendor): general-link section in the vendor-links manager"
```

---

## Task 12: Full verification

- [ ] **Step 1: Backend — run the new file + vendor regression set**

Run: `cd apps/backend && npx vitest run tests/vendor-general-link.test.ts tests/vendor-bids.test.ts tests/vendor-public.test.ts tests/vendor-links.test.ts tests/vendor-promote-validation.test.ts tests/vendor-bid-promote-fx.test.ts tests/vendor-bids-currency-response.test.ts tests/vendor-public-bid-currency.test.ts`
Expected: all PASS.

- [ ] **Step 2: Workspace typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke (desktop)**

Run `pnpm dev`, then as a manager: Vendor bids → Vendor links → "Generate general link" → Copy. Open `/v/<token>` in a private window: the portal header shows "Vendor portal" (no customer). Submit an offer with a contact name. Back in the manager view the bid shows a "General" badge; open it, pick a customer in the footer picker, Promote → a draft sell order is created for that customer.

- [ ] **Step 4: Update CHANGELOG**

Add an entry under the Unreleased section of `CHANGELOG.md` (the pre-push hook enforces this for notable changes):

```
- Vendor portal: a single shareable "general" link not tied to a customer; the customer is chosen when promoting the resulting bid.
```

- [ ] **Step 5: Final commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog — general vendor links"
```

---

## Self-review notes

- **Spec coverage:** migration (Task 1), generate/list (Tasks 2–3), portal `/me` + null bid customer (Task 4), bid list/detail null-safe (Task 5), promote picker + back-fill (Task 6), portal greeting (Task 8), General badge (Task 9), promote UI (Task 10), links-manager section (Task 11), i18n (Task 7), tests woven through, CHANGELOG (Task 12). All spec sections map to a task.
- **Type consistency:** `general` field shape (`{id, token, createdAt, lastSeenAt, bidCount}`) is identical in the backend response (Task 3), the test (Task 3), and the frontend `GeneralLink` type (Task 11). `customerId` body param name matches across backend promote (Task 6) and frontend POST (Task 10). `Customer`/`CustomerPicker` imported from their real definitions.
- **No placeholders:** every code step shows full code and exact commands.
