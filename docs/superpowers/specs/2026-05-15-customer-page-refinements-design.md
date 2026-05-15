# Customer page refinements — design

Date: 2026-05-15
Branch: feat/ram-line-refinements

## Goal

Refine the Customers page and its data model:

1. Auto-hide archived customers (default view shows active only).
2. Remove the On hold / Lead customer statuses — only Active vs Archived remain.
3. Add a postal address to customers.
4. Remove the Credit limit (USD) field.
5. Make the contact structured: contact name, email, phone (plus the customer
   address + country, which double as the contact's address).
6. Remove payment terms — from the customer entity, the sell-order screens,
   and the `payment_terms` lookup table entirely.

## Decisions (resolved during brainstorming)

- **Contact/address model:** one structured contact block. No separate
  contacts table. The customer's address *is* the contact's address (single
  set, no duplication).
- **Removal depth:** drop the real DB columns via a new migration (no dead
  columns), not a UI-only hide.
- **Sell-order payment terms:** removed everywhere. Sell orders have no terms
  column of their own — `customers.terms` was the only source — so payment
  terms disappear from the sell-order list, detail, and draft. No replacement.
- **`payment_terms` lookup table:** dropped. No Settings panel manages it, so
  there is no admin UI to remove.

## Data model

New migration `apps/backend/migrations/0018_customer_contact_address.sql`
(next free number; 0014 was skipped historically, latest is 0017). Follow the
existing migration style: a `-- 0018_…` header comment and idempotent guards.

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
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS address       TEXT;  -- multi-line street address
ALTER TABLE customers ADD  COLUMN IF NOT EXISTS country       TEXT;

DROP TABLE IF EXISTS payment_terms;
```

There is no real `status` column today — Active/Lead/On hold/Archived was
faked in the UI from a hash of the id. After this change, status is purely
derived from the existing `active` boolean: `active ? 'Active' : 'Archived'`.

## Backend

### `apps/backend/src/routes/customers.ts`
- **GET `/`**: SELECT — drop `c.terms`, `c.credit_limit`, `c.contact`; add
  `c.contact_name`, `c.contact_email`, `c.contact_phone`, `c.address`,
  `c.country`. Search clause unchanged (still name / short_name).
- **POST `/`**: body — drop `terms`, `creditLimit`, `contact`; add
  `contactName`, `contactEmail`, `contactPhone`, `address`, `country`.
  INSERT column/value lists updated accordingly. `name` still required.
- **PATCH `/:id`**: same field swap; COALESCE pattern preserved for each new
  column. `active` handling unchanged.

### `apps/backend/src/routes/sellOrders.ts`
- Remove `c.terms AS customer_terms` from both queries (list + detail).
- Remove `terms` from the `customer` object in both responses
  (`customer: { id, name, short, … }`).
- Remove the now-unused `customer_terms` field from the row type annotation.

### `apps/backend/src/routes/lookups.ts`
- Remove the `payment_terms` query from the `Promise.all` (the `termsRows`
  entry).
- Remove `paymentTerms: termsRows.map(...)` from the JSON response.

### `apps/backend/scripts/seed.mjs`
- Rewrite the 6 demo customers: replace `contact` / `terms` / `creditLimit`
  with `contactName`, `contactEmail`, `contactPhone`, `address`, `country`.
  Update the INSERT to the new column set.
- Delete the `PAYMENT_TERMS` block (the `DELETE FROM payment_terms` + insert
  loop).

### `apps/backend/scripts/migrate.mjs`
- Remove `payment_terms` from the `--reset` DROP TABLE list (table no longer
  exists post-migration; `IF EXISTS` makes it harmless but keep the list
  accurate).

## Frontend — Customers panel (`apps/frontend/src/pages/desktop/DesktopSettings.tsx`)

- **`Customer` type (line ~20):** drop `contact`, `terms`, `credit_limit`;
  add `contact_name`, `contact_email`, `contact_phone`, `address`, `country`
  (all `string | null`).
- **`CustomerStatus` / `STATUS_CHIP`:** reduce to `'Active' | 'Archived'`.
- **`deriveCustomerSeed`:** `status = c.active ? 'Active' : 'Archived'`. Keep
  the deterministic `outstanding` and `lastDays` mocks unchanged (out of
  scope).
- **Filter (auto-hide archived):** segmented control becomes
  `Active` (default) · `Archived` · `All`. Initial `statusFilter = 'Active'`
  so archived customers are hidden until explicitly selected. Filtering stays
  client-side (GET still fetches all).
- **Stat tiles:** drop the "leads · on hold" sub-text; show active vs
  archived counts. `counts` object: `{ all, Active, Archived }`.
- **Table:** drop the **Terms** column (`<th>Terms</th>` + the `c.terms`
  cell). Contact sub-line under the customer name shows `contact_name` (fall
  back to `contact_email`, then `—`). Region/Status/Lifetime/Outstanding/
  Last order columns unchanged.
- **Search:** keep; match against name, short_name, contact_name,
  contact_email (replacing the old single `contact`).
- **`CustomerEditModal`:** remove the Terms `<select>` and the Credit limit
  number input. Add fields: Contact name, Contact email, Contact phone,
  Address (`<textarea>`), Country. Keep name, short name, region, notes,
  active toggle. New-customer default loses `terms: 'Net 30'` →
  `{ active: true, tags: [] }`. Save payload updated to the new field names.

## Frontend — Sell orders

### `apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx`
- Remove `import { paymentTerms } from '../../lib/lookups'`.
- Remove the `terms` state, the `setTerms` prefill from the first customer,
  the `setTerms(c.terms)` calls on customer pick, and `terms` from the local
  `Customer` type.
- Remove the entire "Payment terms" `<label>` + `<select>` block.
- Remove `{c.terms} · ` from the customer picker sub-line (keep region).

### `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`
- Remove `terms` from the two `customer: { … }` type literals (lines ~30,
  ~58).
- Remove the terms chip in the list row (`<td><span class="chip">{o.customer.terms}</span></td>`)
  and the `· {order.customer.terms}` in the detail header.

## Frontend — lookups lib (`apps/frontend/src/lib/lookups.ts`)

- Remove `export const paymentTerms`.
- Remove `paymentTerms` from the `LookupsResponse` type.
- Remove `paymentTerms.splice(...)` in `loadLookups`.
- Remove `paymentTerms.length = 0` in `resetLookups`.

## Out of scope (unchanged)

- Outstanding A/R and last-order remain deterministic UI mocks.
- `price_sources`, `sell_order_statuses`, `catalog_options`, workflow stages —
  untouched.
- No tags editor is added (tags remain data-only, as today).

## Testing / verification

- `pnpm --filter recycle-erp-backend db:reset` runs the new migration + seed
  cleanly (no reference to dropped columns/tables).
- Backend typecheck passes (`customers.ts`, `sellOrders.ts`, `lookups.ts`).
- Frontend typecheck passes (no remaining references to `terms`,
  `credit_limit`, `contact`, or `paymentTerms`).
- Manual: Customers panel defaults to Active-only; Archived/All toggles work;
  create/edit modal shows the new contact/address fields and round-trips;
  sell-order draft and list render with no payment-terms UI.
