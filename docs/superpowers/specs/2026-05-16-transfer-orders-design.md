# Transfer Orders — Design

Date: 2026-05-16
Status: Approved

## Problem

The just-shipped receive/transfers feature
(`docs/superpowers/specs/2026-05-15-inventory-receive-transfers-design.md`)
moves multiple inventory lines in one submission but stores **no grouping**:
each line gets a `warehouse_id` override + `status='In Transit'` + an
individual `transferred` audit event. The Transfers page groups lines only
by a derived `from → to` label, so distinct submissions between the same
warehouses visually merge, there is no order identity to reference, and
receipt is a loose bulk-select of lines rather than confirming a coherent
shipment.

The user wants a first-class **Transfer Order**: one transfer creates an
order grouping the items moved together; the page shows orders (each with
its items); a manager confirms the whole order; each order can be exported
and printed; a received order can be re-opened.

## Decisions (locked with user)

| Question | Decision |
|---|---|
| Order model | First-class `transfer_orders` entity, visible id `TO-<n>` |
| Confirm mode | Whole order only (all lines → `Done` at once) |
| Existing flat list | Replaced by the order-grouped view |
| Pre-change In-Transit lines | Greenfield — no backfill |
| Export | Per-order CSV download (reuse existing builder) |
| Printable manifest | Browser-print HTML (no PDF lib), any status |
| Re-open | `Received → Pending`; lines `Done → In Transit`, only if every line untouched since receipt; else block (all-or-nothing) |
| Page visibility | Page shows Pending **and** Received; status filter Pending \| Received \| All (default Pending) |

## Architecture

A new `transfer_orders` table owns the order identity and lifecycle. A
nullable `order_lines.transfer_order_id` points to the order a line is
*currently* moving under; durable history stays in the append-only
`inventory_events`. No join table — a line belongs to at most one active
transfer order (YAGNI). The frontend `/transfers` route, sidebar nav, and
router wiring are unchanged; only the page body and the inventory
endpoints change.

### Schema — migration `apps/backend/migrations/0028_transfer_orders.sql`

```sql
CREATE TABLE IF NOT EXISTS transfer_orders (
  id                 TEXT PRIMARY KEY,                 -- e.g. TO-1042
  from_warehouse_id  TEXT REFERENCES warehouses(id),   -- NULL = mixed sources
  to_warehouse_id    TEXT NOT NULL REFERENCES warehouses(id),
  note               TEXT,
  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL DEFAULT 'Pending',  -- Pending | Received
  received_at        TIMESTAMPTZ,
  received_by        UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS transfer_orders_status_idx
  ON transfer_orders(status, created_at DESC);

ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS transfer_order_id TEXT REFERENCES transfer_orders(id);
CREATE INDEX IF NOT EXISTS order_lines_transfer_order_idx
  ON order_lines(transfer_order_id);
```

No backfill — pre-change In-Transit lines simply won't appear on the page
(still fixable via the per-line edit dialog). `id` is generated like
`orders.ts` does for `SO-<n>`: `SELECT max(int)` over `id ~ '^TO-[0-9]+$'`,
then `'TO-' + (max+1)`, inside the transfer transaction.

## Backend (`apps/backend/src/routes/inventory.ts` + migration)

### `POST /transfer` (existing route, modified)

Inside the existing `sql.begin` transaction, **before** the per-line loop:
generate the `TO-<n>` id; compute `from`: the single common
`effective_wh` of all requested lines, or `NULL` if they differ;
`INSERT INTO transfer_orders (id, from_warehouse_id, to_warehouse_id, note,
created_by, status) VALUES (..., 'Pending')`. Then in the existing
per-line loop, in addition to today's `warehouse_id` + `status='In Transit'`
writes, also set `transfer_order_id = <TO id>` on every moved line and on
every cloned (partial) line, and add `transfer_order_id` to the
`transferred` event `detail`. Response gains `transferOrderId`.

### `GET /transfer-orders` (replaces `GET /transfers`)

Manager-only (403 otherwise). Query param `status` ∈
`pending | received | all` (default `pending`; `pending`→`Pending`,
`received`→`Received`, `all`→no filter). Returns
`{ orders: [...] }`, each order =

- header: `id`, `from_warehouse_id`, `from_short`, `to_warehouse_id`,
  `to_short`, `note`, `status`, `created_at`, `created_by_name`,
  `received_at`, `item_count`, `unit_count`;
- `lines`: the `order_lines` rows with `transfer_order_id = order.id`
  (item identity fields, qty, the line's prior `from` via the latest
  `transferred` event `detail.from`, `from_short`, `transferred_at`),
  ordered by line position.

Newest order first. `LIMIT 200` orders.

### `POST /transfer-orders/:id/receive` (replaces `POST /receive`)

Manager-only. 404 if order unknown. 400 if order `status != 'Pending'`.
In one transaction: every line with `transfer_order_id = :id` **and**
`status = 'In Transit'` → `status = 'Done'` + a `received` event
(`detail = { at: <to warehouse>, transfer_order_id: :id }`). Set order
`status='Received'`, `received_at=NOW()`, `received_by=<user>`. No request
body. (Lines that already left `In Transit` are simply skipped — greenfield
tolerance; the order is still marked Received.)

### `POST /transfer-orders/:id/reopen` (new)

Manager-only. 404 if unknown. 400 if order `status != 'Received'`.

The reopenable line set is exactly the lines that **currently** point to
the order: `WHERE transfer_order_id = :id`. A line re-transferred into a
later order had its `transfer_order_id` overwritten to that newer order, so
it is naturally excluded — it now belongs to its new order, not this one;
re-open does not chase it. **Safety guard** — every line in that set must
satisfy ALL of:

- `status = 'Done'` (not already moved on to another state), and
- `NOT EXISTS (SELECT 1 FROM sell_order_lines sl WHERE sl.inventory_id = line.id)`
  (not committed to a sell order).

If **any** line in the set fails: `409` with a message naming the offending
line id(s); **no writes**. If the set is empty (every line was
re-transferred away): `409` "nothing to re-open". If **all** pass, in one
transaction: each line `status='Done' → 'In Transit'` + a `reopened` event
(`detail = { transfer_order_id: :id }`); order `status='Received' →
'Pending'`, `received_at=NULL`, `received_by=NULL`.

The old `/transfers` and `/receive` endpoints are removed (just shipped,
greenfield — safe to replace).

## Frontend (`apps/frontend/src/pages/desktop/DesktopTransfers.tsx` + i18n)

Reworked from a flat grouped table into a list of **transfer-order cards**,
with a status filter pill row (**Pending | Received | All**, default
Pending) that refetches `GET /transfer-orders?status=`.

Each card:
- Header: `TO-id` · `FROM → TO` (FROM = `from_short`, or `t('transferMixed')`
  when `from_warehouse_id` is null) · created date · creator · note ·
  item-count · a status chip (`Pending`/`Received`, reuse `statusTone`).
- Read-only item table (item label, qty, from, transferred date) — no
  per-row checkboxes (whole-order model).
- Actions, status-aware:
  - **Confirm received** (Pending only) → `POST /transfer-orders/:id/receive`,
    then refetch + toast.
  - **Re-open** (Received only) → `POST /transfer-orders/:id/reopen`; on
    `409` show the returned guard message via an error toast.
  - **Export CSV** (any) → reuse the existing `downloadCsv` helper scoped
    to that order's rows, filename `transfer-<TO-id>.csv`.
  - **Print manifest** (any) → see below.

Page-level bulk-select and page-wide export are removed. The `rowLabel`
and `downloadCsv` helpers are retained (downloadCsv now called per order).

### Printable manifest

A `TransferManifest` component renders a packing-list layout for one order
(header: TO-id, FROM→TO, created date, creator, note; item table; totals:
line count + unit sum). "Print manifest" sets the manifest into a
print-target container and calls `window.print()`. A print-only CSS scope
(a `@media print` rule plus a body class toggled while printing, or a
dedicated `.print-only` / `.no-print` convention) hides the rest of the
app chrome so only the manifest prints. No backend route, no new
dependency. Reverted on `afterprint`.

### i18n (`apps/frontend/src/lib/i18n.tsx`)

Add the new order/card/manifest/filter strings to **both** `en` and `zh`
(`transferOrderTitle`, card labels, `transferReopen`, `transferMixed`,
filter labels, manifest labels, toasts incl. the reopen-blocked message).
Remove now-unused keys from the prior flat list
(`transfersColFrom`/`To` were already removed; drop any others the new
page no longer references). Keep keys still used.

### Activity drawer (`apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx`)

Add a `reopened` kind symmetric with `received`: `Filter` union, counter
init, `ACTION_META` (`{ icon: 'arrow', label: 'Re-opened', dot:
'var(--warn)' }` — confirm `arrow` is a valid `IconName`; else use an
existing back/undo-style icon), filter-pill list, and the `EventCard`
`summary` chain. `transfer_order_id` rides along in `transferred`/
`received`/`reopened` detail; no extra rendering required.

## Data flow

```
Transfer  : POST /transfer → INSERT transfer_orders(Pending) +
            lines get transfer_order_id + status In Transit + 'transferred'
            event (detail.transfer_order_id)
List      : GET /transfer-orders?status= → orders + their In-Transit lines
Receive   : POST /transfer-orders/:id/receive → all In-Transit lines Done +
            'received' events; order Received
Re-open   : POST /transfer-orders/:id/reopen → guard all lines untouched;
            lines In Transit + 'reopened' events; order Pending
Export    : client-side CSV per order (existing builder)
Manifest  : client-side print view per order (window.print)
```

## Testing

Backend (`apps/backend/tests/transfers.test.ts` — rewritten to the order API):
- `POST /transfer` creates exactly one `TO-<n>` order, links every moved
  (and partial-clone) line via `transfer_order_id`, and the `transferred`
  event detail carries `transfer_order_id`.
- `GET /transfer-orders`: 403 non-manager; default returns only `Pending`;
  `?status=received` and `?status=all` filter correctly; each order
  includes its In-Transit lines + from/to enrichment.
- `POST /transfer-orders/:id/receive`: flips all lines→`Done`, order→
  `Received`; 404 unknown; 400 already-Received; 403 non-manager;
  the order then appears only under `received`/`all`.
- `POST /transfer-orders/:id/reopen`: happy path reverts lines→`In Transit`
  + order→`Pending`; 400 if not `Received`; `409` (no writes) when a line
  in the set is in a `sell_order_lines` row; `409` "nothing to re-open"
  when every line was re-transferred away; 403 non-manager.

Frontend: existing `tests/route.test.ts` unchanged (path stays
`/transfers`). No component test harness exists; rely on typecheck + build
+ the backend suite + manual smoke.

## Out of scope (YAGNI)

- Backfill of pre-change transfers.
- Partial / per-item receive.
- PDF export (manifest is browser-print HTML).
- A separate received-order history page (the status filter covers it).
- Editing a transfer order's contents after creation.
