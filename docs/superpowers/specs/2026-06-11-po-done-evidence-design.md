# PO "Done" evidence — optional note & attachments

2026-06-11

## Goal

When a manager moves a purchase order to **Done**, optionally capture a text
note and/or file attachments — the same evidence mechanism sell orders already
have on status changes. Evidence is **optional** (matching the relaxed v1.3.4
sell-order behavior): the dialog appears, but the manager can confirm with
nothing filled in.

## Approach

Mirror the sell-order per-status evidence design (migration 0003) one-to-one
for purchase orders, scoped to the single status that matters: `Done`.
Rejected alternatives: a generic polymorphic attachments table (bigger refactor,
deviates from the proven pattern) and stuffing notes into `orders.notes`
(no attachments, no audit trail).

## Schema (migration 0068)

Two tables, shaped exactly like their sell-order siblings:

- `order_status_meta` — PK `(order_id, status)`, `status CHECK (status IN ('Done'))`,
  `note TEXT`, `set_at`, `set_by UUID REFERENCES users(id) ON DELETE SET NULL`.
- `order_status_attachments` — UUID PK, `order_id TEXT REFERENCES orders(id)
  ON DELETE CASCADE`, same `status` CHECK, `filename`, `size_bytes`,
  `mime_type`, `storage_key`, `delivery_url`, `uploaded_at`,
  `uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL`.
- Indexes: `(order_id, status)` on the attachments table, plus FK indexes on
  `set_by` / `uploaded_by` (per the FK-index convention).

The status CHECK starts as `('Done')` only; widening later is a DB-only change.

## Backend (`routes/orders.ts`)

Three endpoints, manager-only, mirroring `sellOrders.ts` lines 725–867:

- `PUT /api/orders/:id/status-meta/:status` — upsert the note; write an
  `order_events` row `kind='status_meta_changed'`
  (`{status, field:'note', from, to}`) when it changes.
- `POST /api/orders/:id/status-meta/:status/attachments` — multipart `file`;
  validate against `getUploadLimits()` (mime + size); upload to R2 under
  `orders/<id>/<status>` via `uploadAttachment`; insert row; audit event
  (`field:'attachment_added'`).
- `DELETE /api/orders/:id/status-meta/:status/attachments/:attachmentId` —
  delete row, best-effort R2 delete outside the tx, audit event
  (`field:'attachment_removed'`).

Valid statuses come from a local `PO_META_STATUSES = new Set(['Done'])`
constant — PO lifecycle stages are a hardcoded map, not a table, so there is
no `needs_meta` column to read.

`GET /api/orders/:id` additionally returns
`statusMeta: { [status]: { note, when, attachments: [{id, filename, size, mime, url, uploadedAt}] } }`.

`POST /:id/advance` is **unchanged** — no evidence gate. The dialog persists
note/attachments live before the transition commits, same as sell orders.

## Frontend

- **`StatusChangeDialog`** gains an optional `apiBase` prop (default
  `/api/sell-orders`) and a `purchase-done` preset (own title/sub/placeholder
  i18n strings) so the same component serves both order types.
- **Desktop (`DesktopEditOrder`)**: when a manager clicks the `Done` stage in
  the stepper, the dialog opens; *Confirm* stages the status (existing
  Save → PATCH + `/advance` flow commits it), *Cancel* leaves the stepper
  unchanged. Live-saved evidence survives a cancel — same semantics as sell
  orders. When the order is Done, the note + attachment chips render
  read-only near the stepper.
- **Mobile (`OrderDetail`)**: the manager-only *Advance* button from
  Reviewing → Done opens the dialog first; *Confirm* fires the existing
  `/advance` call. Done orders show the evidence read-only.
- **`OrderActivityLog`** learns the `status_meta_changed` kind, reusing the
  rendering/i18n already in `SellOrderHistory`.
- New i18n keys (EN + ZH) for the PO Done preset.

## Testing

New integration test file `tests/order-status-meta.test.ts`:

- 403 for non-managers on all three endpoints.
- Note upsert + `status_meta_changed` event written; no event when unchanged.
- Attachment upload happy path (stub R2), mime rejection (415), size cap (413).
- Attachment delete + audit event; 404 on wrong order/status.
- `GET /:id` returns the `statusMeta` shape.
- `/advance` to done still works with no evidence (optionality).
- Invalid status (e.g. `Reviewing`) rejected with 400.

## Out of scope

- Evidence on other PO stages (CHECK widening is a later DB-only change).
- Requiring evidence (it's optional by design).
- Vendor portal surfaces.
