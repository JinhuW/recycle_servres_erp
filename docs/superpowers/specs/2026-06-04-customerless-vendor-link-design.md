# Customer-less ("general") vendor links — design

Date: 2026-06-04
Status: Approved (brainstorm)

## Problem

Today every vendor portal link is bound to exactly one customer. A link is
minted from a customer row (`POST /api/customers/:id/vendor-link`) and
`vendor_links.customer_id` is `NOT NULL`. The `customer_id` is used only for:

- the portal greeting (`GET /api/public/vendor/:token/me` shows the customer
  name), and
- stamping `vendor_bids.customer_id`, which flows into the sell order when a
  manager promotes a bid.

The catalog itself is already workspace-wide — a link does **not** scope which
inventory a vendor sees. We want a single shareable link that is **not** tied to
any specific customer, so the same URL can be handed to any vendor. The vendor
already types a contact name on submission; the actual customer is chosen by a
manager when the bid is promoted to a sell order.

## Decisions

- **Add alongside, don't replace.** Per-customer links keep working unchanged.
  General links are a parallel capability. No backfill of existing rows.
- **Exactly one active general link.** Mirrors the per-customer rotation
  pattern: generating a new general link deactivates the prior active one so a
  leaked token can be rotated. Not multiple labeled links.
- **Customer chosen at promote time.** A bid from a general link carries
  `customer_id = NULL` until a manager promotes it. At promote the manager picks
  a customer (reusing the existing `CustomerPicker`); the choice is written to
  the sell order **and** back-filled onto the bid so attribution is recorded.
- **Generic greeting.** For a general link the portal header shows a neutral
  title instead of a customer name.

## Data model — migration `0064`

Only two `NOT NULL` constraints drop. No data migration.

```sql
ALTER TABLE vendor_links ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE vendor_bids  ALTER COLUMN customer_id DROP NOT NULL;
```

- `vendor_links.customer_id` nullable — a general link has `NULL`. Existing
  `ON DELETE CASCADE` is irrelevant when null; left as-is.
- `vendor_bids.customer_id` nullable — an unattributed bid has `NULL` until
  promoted. Its FK has no explicit `ON DELETE` rule today (NO ACTION); unchanged.
- `sell_orders.customer_id` stays `NOT NULL` — a sell order always has a
  customer; the promote-time picker enforces it.

A partial unique index guards the "exactly one active general link" invariant:

```sql
CREATE UNIQUE INDEX vendor_links_one_active_general
  ON vendor_links ((customer_id IS NULL))
  WHERE customer_id IS NULL AND active = TRUE;
```

This indexes a constant (`true`) for every active customer-less row, so at most
one can exist. The generate path also deactivates first (below), so the index is
a backstop, not the primary mechanism.

## Backend

### Link generation & listing — `routes/customers.ts`

- **New** `POST /api/customers/vendor-links` (manager only) — mint/rotate the
  general link. Deactivate any prior active general link, insert a new one with
  `customer_id = NULL`, return `{ id, token }`. Same token generation as the
  per-customer endpoint. Path is a single literal segment, so it does not
  collide with `POST /:id/vendor-link` (two segments) or the `GET` of the same
  path (different method).

  ```sql
  WITH deact AS (
    UPDATE vendor_links SET active = FALSE
    WHERE customer_id IS NULL AND active = TRUE
  )
  INSERT INTO vendor_links (customer_id, token, created_by)
  VALUES (NULL, ${token}, ${u.id})
  RETURNING id, token
  ```

- `GET /api/customers/vendor-links` — response gains a `general` field
  alongside the existing per-customer `items`:

  ```ts
  { items: VendorLinkRow[], general: GeneralLink | null }
  ```

  where `GeneralLink = { id, token, createdAt, lastSeenAt, bidCount }`. Computed
  from the active `customer_id IS NULL` row with the same bid-count rollup used
  for per-customer rows. The per-customer LATERAL query is unchanged (it already
  filters `customer_id = c.id`, so general links never leak into `items`).

- Revoke reuses the existing `PATCH /api/customers/vendor-link/:linkId`
  (`{ active: false }`) — it operates purely by link id and is already
  customer-agnostic. No change.

### Public portal — `routes/vendorPublic.ts`

- `loadLink` already selects `customer_id`; its `Link.customer_id` type becomes
  `string | null`.
- `GET /:token/me` — when `customer_id` is null, return
  `{ customer: null, label }` instead of looking up a customer and 404-ing. When
  set, behave exactly as today.
- `POST /:token/bids` — the insert already stamps `link.customer_id`; with the
  column now nullable this transparently stores `NULL` for general links. No
  other change. Catalog, fx, and the per-link flood throttle are untouched.

### Bid management — `routes/vendorBids.ts`

- `GET /` (list) and `GET /:id` (detail): change `JOIN customers cu` to
  `LEFT JOIN customers cu`. `customer_name` / `customer_id` in the response
  become nullable.
- `POST /:id/promote`:
  - Read `customer_id` from the bid as today.
  - If the bid has a `customer_id`, ignore any body and use it (current
    behaviour).
  - If the bid's `customer_id` is null, require `customerId` in the request
    body. Validate the customer exists (`SELECT 1 FROM customers WHERE id = …`);
    400 `customer required` if missing from the body, 400 `customer not found` if
    it doesn't resolve. Use it for the `sell_orders` insert and back-fill it onto
    the bid: `UPDATE vendor_bids SET customer_id = ${chosen} WHERE id = ${id}`.
  - Everything else (FX, line revalidation, audit event, outcome-cast pattern)
    is unchanged; the audit event's `customerId` reflects the chosen customer.

## Frontend

### Portal — `VendorApp.tsx`

- `me` type: `{ customer: { name: string } | null; label: string | null }`.
- Header subtitle (mobile line ~463, desktop line ~844): when `me.customer` is
  present, keep `${t('vendorSharedWith')} · ${me.customer.name}`; otherwise show
  `me.label` if set, else the generic `t('vendorPortal')`.

### Manager bids — `DesktopVendorBids.tsx`

- `VbSummary.customer_name` / `VbDetail.customer_id` / `VbDetail.customer_name`
  become nullable.
- **List/detail rendering:** when `customer_name` is null, render a muted
  "General" chip (`t('vbGeneralLink')`) where the customer name would go; the
  vendor's `contact_name` already shows in its own column/subtitle.
- **Promote with no customer:** in `VendorBidDetail`, when `bid.customer_id` is
  null, render the existing `CustomerPicker` (exported from
  `DesktopSellOrderDraft.tsx`) in the footer/body. Track a local
  `promoteCustomerId`. Disable Promote until it's set; pass `{ customerId }` to
  the promote endpoint. When `bid.customer_id` is set, no picker shows and the
  body is omitted.
- **`VendorLinksManager`:** add a **General link** section above the
  per-customer table, driven by the new `general` field:
  - No active general link → a single "Generate general link" button.
  - Active general link → the URL chip + Copy + Revoke + Regenerate, reusing the
    same `urlFor` / `shareOrCopy` / revoke-by-link-id machinery. Bid count and
    last-seen shown like a per-customer row.
  - Generate/Regenerate calls `POST /api/customers/vendor-links`; revoke calls
    the existing `PATCH /api/customers/vendor-link/:linkId`.

### i18n — `lib/i18n.tsx`

New EN + ZH keys: general-links section header/subtitle, generate/regenerate
labels, "General" bid badge (`vbGeneralLink`), promote-time customer prompt, and
the portal generic title (`vendorPortal`). No raw English in JSX.

## Error handling

- Promote of an unattributed bid without `customerId` → 400 `customer required`;
  the UI disables the button first so this is a backstop.
- `customerId` that doesn't resolve → 400 `customer not found`.
- Both use the existing post-transaction outcome-cast pattern in the promote
  handler — no new control-flow shape.

## Testing

Backend integration tests (`apps/backend/tests`, real Postgres):

- Generate a general link → row has `customer_id IS NULL`; generating again
  deactivates the prior one (exactly one active general link).
- `GET /api/customers/vendor-links` returns `general` populated and absent from
  `items`.
- `GET /:token/me` for a general link returns `customer: null`.
- `POST /:token/bids` on a general link stores `vendor_bids.customer_id IS NULL`.
- `POST /:id/promote` without `customerId` on an unattributed bid → 400.
- `POST /:id/promote` with a valid `customerId` → creates the sell order with
  that customer and back-fills `vendor_bids.customer_id`.
- Per-customer link/bid/promote path still passes unchanged (regression).

Run single files with `cd apps/backend && npx vitest run tests/<file>.test.ts`.

## Out of scope

- Multiple / labeled general links (chose exactly one active).
- Per-link inventory scoping (catalog stays workspace-wide).
- Any change to the per-customer link workflow.
