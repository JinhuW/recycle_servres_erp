# Sell-order archive design

Date: 2026-05-22
Status: Approved — implementation pending

## Goal

Let managers reversibly hide sell orders from the default list without
losing them. Mirrors the purchase-order archive shipped in migration
`0045_orders_archived_at.sql` and the `/api/orders/:id/archive` endpoints,
but scoped to sell orders and with a different entry-point UX.

## Non-goals

- No PO-side changes.
- No mobile UI (no mobile SO detail surface exists today).
- No bulk archive, no auto-archive on `Done`.
- No backfill of historical `sell_order_events` from existing rows.
- No event emission beyond `archived` / `unarchived` in this round. The
  events table is introduced now because archive needs an audit row; other
  SO event kinds (status changes, line edits, meta) are a follow-up.

## Architecture

Reversible soft-hide via `sell_orders.archived_at TIMESTAMPTZ NULL`. The
row stays intact so commissions, sell-order lines, references, and the
new per-SO audit log survive. The list view filters `archived_at IS NULL`
by default; a `Show archived` toggle on the desktop page opts back in.

Archive is distinct from delete: hard delete still only works on Draft.
Archive is the manager's tool for tidying any non-Draft sell order.

Sell orders get their own audit log table, `sell_order_events`, modeled
on `order_events` but independent — no FK relationship to PO. This change
emits only `archived` / `unarchived` event kinds; the schema is ready for
other kinds when their callers are wired up later.

## Database

### Migration `0046_sell_orders_archived_at.sql`

```sql
ALTER TABLE sell_orders
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_sell_orders_active_created
  ON sell_orders (created_at DESC)
  WHERE archived_at IS NULL;
```

The partial index covers the hot path (default list = active only).

### Migration `0047_sell_order_events.sql`

```sql
CREATE TABLE IF NOT EXISTS sell_order_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sell_order_id TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  actor_id      UUID REFERENCES users(id),
  kind          TEXT NOT NULL, -- archived | unarchived | (future: submitted, advanced, line_*, meta_changed)
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sell_order_events_order_idx
  ON sell_order_events(sell_order_id, created_at DESC);

CREATE OR REPLACE FUNCTION sell_order_events_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sell_order_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sell_order_events_no_update ON sell_order_events;
DROP TRIGGER IF EXISTS sell_order_events_no_delete ON sell_order_events;
CREATE TRIGGER sell_order_events_no_update BEFORE UPDATE ON sell_order_events
  FOR EACH ROW EXECUTE FUNCTION sell_order_events_lock();
-- Note: BEFORE DELETE fires even on CASCADE. Sell orders can only be deleted
-- while in 'Draft' status (no events emitted yet), so the cascade never has
-- rows to delete in practice.
CREATE TRIGGER sell_order_events_no_delete BEFORE DELETE ON sell_order_events
  FOR EACH ROW EXECUTE FUNCTION sell_order_events_lock();
```

## Backend

All changes in `apps/backend/src/routes/sellOrders.ts`.

### List endpoint changes — `GET /api/sell-orders`

- Accept `?includeArchived=true|false` (default false).
- Add to the WHERE clause: `AND (${includeArchived} OR so.archived_at IS NULL)`.
- Include `so.archived_at` in the SELECT and map to `archivedAt` in the
  response item shape.

### Detail endpoint changes — `GET /api/sell-orders/:id`

- Include `archived_at` in the SELECT and `archivedAt` in the response.

### New endpoints

```
POST /api/sell-orders/:id/archive    → 200 { ok: true } | 403 | 409
POST /api/sell-orders/:id/unarchive  → 200 { ok: true } | 403 | 409
```

Both manager-only. Both wrap a single `sql.begin` transaction that:

1. `SELECT status, archived_at FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE`
   — row-level lock prevents archive/unarchive races and double-emission of
   audit events.
2. Reject when status is `'Draft'`:
   `{ error: 'Draft sell orders cannot be archived — delete instead' }`, 403.
3. If `(archived_at !== null) === archive`, return
   `{ ok: true, kind: 'noChange' }` (200) — idempotent retry behavior
   matching PO.
4. `UPDATE sell_orders SET archived_at = NOW()|NULL WHERE id = ${id}`.
5. `INSERT INTO sell_order_events (sell_order_id, actor_id, kind, detail)
    VALUES (${id}, ${actorId}, ${archive ? 'archived' : 'unarchived'}, '{}'::jsonb)`.

Errors out of the transaction propagate as 500 (no swallowing).

The implementation mirrors `setArchived` in
`apps/backend/src/routes/orders.ts:769` — same return-kind discriminator
(`noChange` | `isDraft` | `notFound` | `ok`) and the same outer handler
that maps each kind to a status code.

## Frontend

### API helpers — `apps/frontend/src/lib/api.ts`

```ts
export const archiveSellOrder = (id: string) =>
  api.post<{ ok: true }>(`/api/sell-orders/${id}/archive`, {});
export const unarchiveSellOrder = (id: string) =>
  api.post<{ ok: true }>(`/api/sell-orders/${id}/unarchive`, {});
```

CSRF flows through `api.post` — no special handling needed.

### Types — `apps/frontend/src/lib/types.ts` / inline in `DesktopSellOrders`

Add `archivedAt: string | null` to the SO summary and detail types.

### SO edit modal — inside `DesktopSellOrders.tsx`

Add a red **Archive** action in the modal footer (next to the existing
actions, mirroring how `DesktopEditOrder.tsx:983` places the PO archive
button). Behavior:

- Hidden when status is `Draft` (use Delete instead).
- When `archivedAt !== null` the button flips to a neutral
  **Unarchive** (no confirmation dialog — unarchive is non-destructive).
- Clicking **Archive** opens the type-to-confirm dialog (below).

### Type-to-confirm dialog — new `ArchiveSellOrderDialog` component

A small modal owned by `DesktopSellOrders.tsx` (kept local rather than
extracted — the only consumer):

- Title: `Archive sell order`
- Body label: `Type SO-1234 to confirm archive` (interpolating the actual
  order id).
- Single text input, monospaced, autofocused, no normalization beyond
  trim.
- The destructive **Archive** confirm button is disabled until the typed
  value equals the order's id exactly (case-sensitive).
- On submit: call `archiveSellOrder(id)`. On 200 → close both dialogs,
  toast `Archived SO-1234`, refresh the list. On 4xx → render the
  backend `error` field inline, leave the dialog open.
- Esc / backdrop click closes; same styling pattern as
  `StatusChangeDialog`.

### List view — `DesktopSellOrders.tsx`

- New `Show archived` toggle in the card header
  (`usePersisted<boolean>('desktop.sellOrders.showArchived', false)`),
  styled identically to the PO list toggle.
- When on, append `?includeArchived=true` to the SO list fetch.
- Render an `archived` chip in the id cell when `o.archivedAt` is truthy,
  and fade the row (`opacity: 0.55`) — same treatment as PO list rows.

## Tests

New file `apps/backend/tests/sell-orders-archive.test.ts`:

- Archive happy path: archives a non-Draft SO; row's `archived_at` is set;
  one `sell_order_events` row with `kind: 'archived'`.
- Idempotent retry: archive twice → second call returns `{ kind: 'noChange' }`
  and does not emit a second event.
- Unarchive round-trip: archive → unarchive; `archived_at` returns to NULL;
  one `sell_order_events` row with `kind: 'unarchived'`.
- Draft rejection: archive on a Draft SO → 403; no event emitted.
- List filter: archived SO hidden by default; appears with `?includeArchived=true`;
  response item includes `archivedAt` ISO timestamp.
- Detail response includes `archivedAt`.
- Concurrent archive: two parallel POSTs against the same SO → exactly one
  writes the timestamp, one returns `noChange` (verifies `FOR UPDATE`).
- Role guard: non-manager → 403.
- Append-only guard: direct `UPDATE sell_order_events …` raises the lock
  exception.

No new frontend tests — UI behavior follows existing patterns and the
parallel PO archive UI has no unit tests either.

## Rollout

- Two migrations applied on the next backend startup.
- No env-var, feature-flag, or settings changes.
- No backward-compat concerns: archived defaults to NULL on existing rows.

## Open questions

None remaining at design time.
