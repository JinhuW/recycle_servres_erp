# Vendor Bidding Link — Design

**Date:** 2026-05-18
**Status:** Approved (pending spec review)

## Problem

The company holds recycled-hardware inventory it wants to liquidate to
external resellers ("vendors"). Today there is no way for an outside party to
see what is in stock or express interest — every `/api/*` route sits behind
`authMiddleware` and the only external-facing share link in the codebase
(`2026-05-15-sell-order-share-link-design.md`) is actually an *internal*
manager-only deep link, not a public surface.

Goal: a per-vendor shareable link (no login) that lets a vendor browse
in-stock inventory and submit price offers ("bids") on the items they want.
A manager reviews offers and accepts the lines worth selling, which flow into
the existing sell-order pipeline.

## Requirements (decided in brainstorming)

1. **Bid model:** Make-an-offer / RFQ. Vendor builds a basket, proposes a qty
   + their own unit price per item, submits. Non-binding, asynchronous.
2. **Link identity:** One link per vendor, tied to a `customers` row. Manager
   generates / revokes. Bids auto-attributed to that customer. Vendor still
   types a contact name on submit.
3. **Inventory scope:** All in-stock items appear automatically — no
   curation. In-stock = `order_lines.status = 'Done'` AND `qty > 0`.
   In-Transit and Reviewing lines are hidden.
4. **Price visibility:** Blind. No price is ever shown to the vendor; every
   item is offer-only. (`unit_cost`/profit are never exposed regardless — and
   here `sell_price` is withheld too.)
5. **Quantity visibility:** Exact available qty is shown; the vendor's
   requested qty is capped at it.
6. **Manager actions:** Accept / reject **per line**. Accepted lines roll
   into one Draft `sell_order` for that customer, finalized in the existing
   sell-order editor. Accepted qty and price are editable at decision time
   (this covers "take fewer / counter the price" without a separate
   counter-offer loop). No vendor-facing negotiation round-trip in v1.
7. **Vendor follow-up:** The link doubles as a status portal. A "My offers"
   view (same token, no login) shows each submitted basket with per-line
   status (Pending / Accepted / Declined) and the accepted price when set.
   No email/SMS (the codebase has no such infrastructure); managers work the
   existing notifications inbox and close out-of-band.

## Chosen Approach — Public namespace + isolated vendor tables

Rejected alternatives:

- **Bids as Draft sell-orders** (no new tables): couples untrusted external
  input directly to the internal sales pipeline and overloads the
  `sell_orders` state machine with a per-line pending/accept lifecycle it was
  not built for. Riskier; rejected.
- **Generic shareable-resource framework:** polymorphic over-engineering for
  a single use case. YAGNI; rejected.

The public surface is physically isolated: new routes under
`/api/public/vendor/:token/*` mounted **before** the `app.use('/api/<x>/*',
authMiddleware)` block in `index.ts`, so they are never covered by auth.
Public handlers query an explicit column allowlist and live in a route file
that never imports authed serializers, making cost/`sell_price` leakage
structurally impossible. Bids live in their own tables and only become
sell-orders when a manager promotes accepted lines.

## Design

### 1. Data model — new migration `0033_vendor_bidding.sql`

```sql
CREATE TABLE vendor_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,        -- URL-safe, >=160-bit random
  label       TEXT,                        -- optional human label
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at  TIMESTAMPTZ,                 -- NULL = never
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ                 -- updated on catalog open
);
CREATE INDEX vendor_links_customer_idx ON vendor_links(customer_id);

CREATE TABLE vendor_bids (
  id            TEXT PRIMARY KEY,          -- human id e.g. VB-1001
  vendor_link_id UUID NOT NULL REFERENCES vendor_links(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id),  -- snapshot at submit
  contact_name  TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','partly_decided','decided')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX vendor_bids_link_idx   ON vendor_bids(vendor_link_id);
CREATE INDEX vendor_bids_status_idx ON vendor_bids(status);

CREATE TABLE vendor_bid_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id          TEXT NOT NULL REFERENCES vendor_bids(id) ON DELETE CASCADE,
  inventory_id    UUID REFERENCES order_lines(id),  -- source line; nullable if later deleted
  -- denormalized item identity at bid time (mirrors sell_order_lines pattern)
  category        TEXT NOT NULL,
  label           TEXT NOT NULL,
  sub_label       TEXT,
  part_number     TEXT,
  offered_qty     INTEGER NOT NULL CHECK (offered_qty > 0),
  offered_unit_price NUMERIC(12,2) NOT NULL CHECK (offered_unit_price >= 0),
  line_status     TEXT NOT NULL DEFAULT 'pending'
                    CHECK (line_status IN ('pending','accepted','declined')),
  accepted_qty    INTEGER,
  accepted_unit_price NUMERIC(12,2),
  decided_at      TIMESTAMPTZ,
  decided_by      UUID REFERENCES users(id),
  sell_order_id   TEXT REFERENCES sell_orders(id),  -- set when promoted
  position        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX vendor_bid_lines_bid_idx ON vendor_bid_lines(bid_id);
```

Add a `'VB'` counter: extend `nextHumanId`'s `name` union to
`'SO' | 'SL' | 'TO' | 'VB'` and seed `INSERT INTO id_counters (name, value)
VALUES ('VB', 1000) ON CONFLICT DO NOTHING;` in the same migration.

### 2. Public API — new route file `routes/vendorPublic.ts`

Mounted in `index.ts` as `app.route('/api/public/vendor', vendorPublicRoutes)`
**before** the authMiddleware `app.use` block. No `authMiddleware`.

A small `loadLink(sql, token)` helper resolves token → row where
`active = TRUE AND (expires_at IS NULL OR expires_at > NOW())`. Any miss
(unknown / inactive / expired / revoked) returns a neutral **404** — never
reveal whether a token exists. On a successful catalog fetch, best-effort
`UPDATE vendor_links SET last_seen_at = NOW()`.

| Method & path | Purpose | Returns |
|---|---|---|
| `GET /:token/me` | Header context | `{ customer:{name,short}, label }` |
| `GET /:token/catalog` | In-stock items | `{ groups:[{ category, items:[…] }] }` — per item: `id, category, brand, capacity, generation, type, classification, rank, speed, interface, form_factor, description, part_number, condition, qty`. **Never** `unit_cost, sell_price, profit, margin, notes, user, warehouse`. |
| `POST /:token/bids` | Submit a basket | `{ bidId }` |
| `GET /:token/bids` | "My offers" | submitted baskets for this link with per-line `line_status`, `accepted_qty`, `accepted_unit_price` |

Catalog query is an explicit-column `SELECT` on `order_lines l JOIN orders o`
filtered `l.status = 'Done' AND l.qty > 0`, grouped by category in the
handler. No cost/sell columns are selected at all.

`POST /:token/bids` body:
`{ contactName: string, note?: string, lines: [{ inventoryId, qty, unitPrice }] }`.
In one `sql.begin` transaction: re-validate every line is still
`status='Done'` and `qty >= requested qty` (reject the whole bid with 409 +
the offending line ids if any fails); allocate `VB-####` via `nextHumanId`;
insert `vendor_bids` (snapshot `customer_id` from the link) + one
`vendor_bid_lines` per line with the item identity snapshot; call
`notifyManagers(tx, { kind:'vendor_bid', icon:'tag', title:`New offer from
${customer.name}`, body:`${n} items · ${contactName}` })`.

Validation: `contactName` non-empty (≤120 chars), `lines` 1–100 entries,
`qty` positive integer, `unitPrice` finite ≥ 0. Reject malformed input 400.

### 3. Manager API — authed

New authed route file `routes/vendorBids.ts`, mounted under
`/api/vendor-bids` with `app.use('/api/vendor-bids/*', authMiddleware)`.
All handlers `403` unless `c.var.user.role === 'manager'`.

| Method & path | Purpose |
|---|---|
| `GET /` | Inbox: bids with customer, contact, line count, total offered, status, created_at. `?status=` filter. |
| `GET /:id` | One bid + its lines, each enriched with **live available qty** (`SELECT qty FROM order_lines WHERE id = inventory_id AND status='Done'`, else 0). |
| `POST /:id/decide` | Body `{ lines:[{ lineId, decision:'accepted'|'declined', acceptedQty?, acceptedUnitPrice? }] }`. Per accepted line: clamp `acceptedQty` to live availability, default price = offered. Sets `line_status`, `accepted_*`, `decided_at/by`. Recompute bid `status` (`new` → `partly_decided` → `decided` when no `pending` lines remain). |
| `POST /:id/promote` | Create one Draft `sell_order` for the bid's `customer_id` from all `accepted` lines not yet promoted (`sell_order_id IS NULL`); insert `sell_order_lines` (link `inventory_id`, qty = `accepted_qty`, price = `accepted_unit_price`); stamp `sell_order_id` back onto the bid lines. Returns the new `SL-####`. |

Promotion reuses the existing sell-order creation path/shape (see
`routes/sellOrders.ts`) so the resulting Draft behaves exactly like a
hand-built one and is finalized in the existing editor. Stock is **only**
committed through that existing pipeline — bids never reserve inventory.

Vendor-link CRUD: extend `routes/customers.ts` (already authed,
manager-gated) with:
`GET /:customerId/vendor-link`, `POST /:customerId/vendor-link` (create /
regenerate — token via `crypto.getRandomValues`, base64url, ≥20 bytes),
`PATCH /vendor-link/:id` (toggle `active`, set `expires_at`/`label`),
`DELETE /vendor-link/:id` (or `active=false` — revoke). One active link per
customer is sufficient; regenerate deactivates the old token.

### 4. Frontend — vendor portal

`App.tsx` gains a third top-level branch **above** the phone/desktop split:
if `window.location.pathname` starts with `/v/`, render `<VendorApp token=…>`
inside `LangProvider` and **return early** — never mount `MobileApp`/
`DesktopApp` (which assume an authed user). `VendorApp` has its own minimal
shell and only calls `/api/public/vendor/:token/*`.

`VendorApp` is mobile-first (vendors are mostly on phones) with three views,
switched by a `Browse ⇄ My offers` segmented control:

- **Browse:** branded header ("Shared with: <customer> · <contact?>"),
  category filter chips, search, items grouped by category. Each item shows
  specs + condition + exact "N available", no price. "+ Add offer" expands
  an inline row: qty input (capped to available) + a visually prominent
  **"Your offer / unit"** field + Add. A sticky bottom bar shows basket
  count → Review.
- **Review & submit:** chosen lines (qty × your price = line total), total
  offered, contact-name field + optional note, Submit. Copy states it is
  non-binding and auto-attributed to the customer.
- **My offers:** submitted baskets with per-line Pending / Accepted /
  Declined badges and accepted price when set.

Basket state is client-side only (React state / `sessionStorage` keyed by
token); nothing persists server-side until Submit. i18n: add a small set of
vendor-portal keys to `lib/i18n.tsx` (follow existing key patterns).

### 5. Frontend — manager surfaces (desktop)

- **Customers page:** a "Vendor link" panel on the customer detail —
  link box with copy/revoke, status pill, created-by, last-opened, bid
  count, optional expiry editor. Reuse existing share/copy affordance
  patterns and toast plumbing.
- **Vendor Bids** (new desktop nav item / view): inbox table → bid detail
  with a per-line table (offered qty/price, **live available**, editable
  accepted qty/price, Accept/Decline segmented control), stock-shortfall
  warning when available < offered, and a footer
  "Create Draft sell-order · N accepted lines" button calling `promote`,
  then navigating into the existing sell-order editor for the new `SL-####`.
  Manager-only; purchasers redirected away as with other manager views.

### 6. Security & concurrency

- **Token:** bearer-style share token, stored unique + indexed in
  plaintext (not a password). Revocation via `active=false` / `expires_at`,
  matching standard share-link practice and the project's existing
  share-link expectations.
- **Enumeration:** all link-resolution failures return an identical 404 with
  no body detail.
- **Spam:** rate-limit `POST /:token/bids` per link (simple per-link
  short-window counter; reuse the project's existing rate-limit approach if
  one exists from `0032_login_attempts`, else a lightweight in-handler
  guard). Excess → 429.
- **No reservation / no overselling:** bids are non-binding and the same
  stock is shown to every vendor. Truth is enforced only at decide/promote
  time — accepted qty is clamped to live availability and the actual stock
  decrement happens through the existing sell-order pipeline. Nothing is
  committed until a manager promotes.
- **Cost isolation:** structural — public handlers select an explicit
  non-cost column list and the public route file imports no authed
  serializer.

### 7. Error handling

- Public: malformed body → 400 with field message; unknown/inactive/expired
  token → 404; line no longer available / qty short at submit → 409 with
  offending `inventoryId`s so the UI can flag those rows.
- Manager: non-manager → 403; promote with zero accepted lines → 400;
  decide on an already-`decided` bid line → idempotent no-op (last write
  wins, re-clamped to availability).

### 8. Testing (vitest, matching existing `tests/` integration style)

- Catalog excludes `unit_cost`/`sell_price` and any non-`Done` or
  `qty=0` line; groups by category.
- Unknown / inactive / expired / revoked token → 404 (no info leak).
- `POST bids`: happy path creates `vendor_bids` + `vendor_bid_lines` +
  manager notification; `qty > available` or delisted item → 409; malformed
  body → 400; over-cap basket size → 400.
- `GET bids` returns only this link's baskets with correct per-line status.
- Manager `decide` clamps accepted qty to live availability and transitions
  bid status (`new` → `partly_decided` → `decided`).
- `promote` creates exactly one Draft `sell_order` for the right customer
  with lines matching accepted qty/price, stamps `sell_order_id` back, and
  is idempotent (re-promote skips already-promoted lines).
- Non-manager blocked from every `/api/vendor-bids/*` endpoint (403).
- Frontend: `App.tsx` renders `VendorApp` (not Mobile/Desktop) for a `/v/…`
  path and never calls authed endpoints.

## Out of scope (possible phase 2)

- Vendor-facing counter-offer negotiation rounds.
- Per-vendor pricing or per-vendor catalog visibility/exclusions.
- Email/SMS notifications to vendors.
- Manager-curated listing toggle.
