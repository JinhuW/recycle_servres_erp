# Sell Order Close Workflow — Design

**Date:** 2026-05-25
**Status:** Approved (brainstorming)
**Touches:** `apps/backend/src/routes/sellOrders.ts`, `apps/backend/src/routes/lookups.ts`, `apps/backend/migrations/`, `apps/backend/scripts/seed.mjs`, `apps/frontend/src/pages/desktop/`

## Goal

Give managers a way to terminate a non-Done sell order that isn't going to
complete normally — customer cancelled, lost deal, returned, duplicate — and
to release the soft-committed inventory back to sellable. Close is reversible
via Reopen, which puts the order back to Draft.

The happy path is unchanged: `Draft → Shipped → Awaiting payment → Done`
still consumes inventory and fires commission notifications at Done. Close
is the off-ramp that lives parallel to that flow, not a step on it.

## Non-goals

- Closing a `Done` order (refund / return). Done is the closed-book record;
  unwinding consumed inventory and walking back commission needs its own
  design.
- Auto-closing an SO when the linked PO is cancelled or otherwise
  transitions. Cross-order propagation is out of scope here.
- Closing-side notifications. Notify fires only on Done today; a
  `sell_order_closed` notify kind can be a follow-up if the team wants it.
- Mobile shell. Sell orders is a manager-only desktop surface today; if
  that changes, revisit chip/filter additions for mobile.

## Data model

Migration `apps/backend/migrations/0053_sell_order_close.sql`:

```sql
-- Extend the sell_orders.status CHECK to admit 'Closed'.
ALTER TABLE sell_orders DROP CONSTRAINT IF EXISTS sell_orders_status_check;
ALTER TABLE sell_orders ADD CONSTRAINT sell_orders_status_check
  CHECK (status IN ('Draft','Shipped','Awaiting payment','Done','Closed'));

-- Reason taxonomy — lookup, not enum, so adding a reason is a seed change.
CREATE TABLE IF NOT EXISTS sell_order_close_reasons (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE
);

-- Denormalized current close-reason. close is exactly-once per close-cycle
-- (reopen clears it); list/detail render the order row already, so the
-- denormalized column avoids a join-to-events for the common case. Reopen
-- history lives in sell_order_events.
ALTER TABLE sell_orders
  ADD COLUMN IF NOT EXISTS close_reason_id TEXT
    REFERENCES sell_order_close_reasons(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS sell_orders_close_reason_idx
  ON sell_orders(close_reason_id) WHERE close_reason_id IS NOT NULL;
```

`ON DELETE RESTRICT` matches the `0041_fk_on_delete.sql` convention for
lookup parents: a reason that has any orders pointing at it can't be
deleted out from under them.

### Seed (`apps/backend/scripts/seed.mjs`)

Two upserts:

1. `sell_order_statuses` — add `{ id: 'Closed', short_label: 'Closed',
   tone: 'muted', needs_meta: true, position: 5 }`.
2. `sell_order_close_reasons` — `customer_cancelled`, `lost_deal`,
   `returned`, `duplicate`, `other` at positions 1-5.

No changes to `sell_order_events` (mig 0050 already accepts arbitrary
`kind`). No new attachments table — close attachments reuse
`sell_order_status_attachments` keyed by `(sell_order_id, status='Closed')`,
identical to Shipped/Awaiting/Done.

## API

No new routes. Extend the existing `POST /api/sell-orders/:id/status`
handler in `apps/backend/src/routes/sellOrders.ts` and the lookups
endpoint.

### Transition map

Replace the linear `SELL_ORDER_FLOW = ['Draft', …]` array with an explicit
map. This is the single source of truth for what status changes are legal;
CLAUDE.md status-guard convention says extend the existing guard, not add
a parallel one.

```ts
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  Draft:               new Set(['Shipped', 'Closed']),
  Shipped:             new Set(['Awaiting payment', 'Closed']),
  'Awaiting payment':  new Set(['Done', 'Closed']),
  Done:                new Set([]),              // terminal happy-path
  Closed:              new Set(['Draft']),       // reopen only
};
```

This subsumes the current `cur.status === 'Done' && body.to !== 'Done'`
lock check (Done's allowed set is empty).

### Request body

```ts
type StatusChangeBody = {
  to: string;
  note?: string;
  attachmentIds?: string[];
  closeReasonId?: string;          // required when to === 'Closed'
};
```

### Handler guards (all inside the existing `sql.begin` row-locked tx)

1. **Transition guard:** if `body.to ∉ ALLOWED_TRANSITIONS[cur.status]` →
   `409 { error: 'illegal transition: <from> → <to>' }`.
2. **Reason guard:** if `body.to === 'Closed'`, `closeReasonId` must exist
   in `sell_order_close_reasons` with `active = true` — else `400`. The
   evidence requirement (note OR attachments) is enforced by adding
   `'Closed'` to the hardcoded `NEEDS_EVIDENCE` JS set at
   `sellOrders.ts:509`. The DB `sell_order_statuses.needs_meta=true` row
   keeps the per-status meta routes (note + attachment uploads keyed by
   `(sell_order_id, status='Closed')`) in sync — those routes already
   look up `needs_meta` dynamically from the DB.
3. **Reopen note requirement:** when `cur.status === 'Closed' && body.to
   === 'Draft'`, require `note`. Implement this as a conditional check in
   the handler, *not* by adding `'Draft'` to the global `NEEDS_EVIDENCE`
   set — that would break the normal Draft→Shipped path (which never
   transitions *into* Draft so the global set would be wrong-flavored).
4. **Reopen cleanup:** on the same transition, `UPDATE sell_orders SET
   close_reason_id = NULL …`.

### Side effects

- **Close:** `UPDATE sell_orders SET status='Closed', close_reason_id=$id`;
  upsert `sell_order_status_meta` with the note (existing pattern);
  `writeSellOrderEvent(tx, id, u.id, 'closed', { reasonId, note,
  fromStatus: cur.status })`.
- **Reopen:** `UPDATE sell_orders SET status='Draft', close_reason_id=NULL`;
  upsert `sell_order_status_meta` for status='Draft' with the reopen note;
  `writeSellOrderEvent(tx, id, u.id, 'reopened', { note, fromStatus:
  'Closed' })`.

### Inventory release

Implicit. The soft-commit check in
`apps/backend/src/routes/sellOrders.ts:53` currently reads:

```sql
AND so.status <> 'Done'
```

Change to:

```sql
AND so.status NOT IN ('Done', 'Closed')
```

A Closed SO's inventory lines become accept-able on a new Draft the moment
the close commits. No per-line UPDATE, no `inventory_events` writes — the
lines were never flipped to `'Sold'` so there's no inventory mutation to
record.

### Lookups endpoint

`apps/backend/src/routes/lookups.ts` already serves `sell_order_statuses`.
Add `sell_order_close_reasons` to the same response under
`closeReasons: { id, label }[]`, ordered by `position` where `active =
true`. One extra `SELECT`.

## Frontend

### Type changes

- `'Closed'` added to the SO status union in `DesktopSellOrders.tsx` (line
  ~32) and `DesktopSellOrderDraft.tsx` (the detail/edit page) and any
  other call sites the TS compiler surfaces.
- Lookups type: add `closeReasons: CloseReason[]`.

### Components

- **New: `apps/frontend/src/pages/desktop/CloseSellOrderDialog.tsx`** —
  modal mirroring the existing `StatusChangeDialog`. Fields:
  - required `<select>` of reasons (driven by lookups);
  - required `<textarea>` note ("Why is this deal being closed?");
  - optional attachments (existing pattern).

  Submits to `POST /api/sell-orders/:id/status` with `{ to: 'Closed',
  closeReasonId, note, attachmentIds }`.

- **Existing: `DesktopSellOrderDraft.tsx`** (the SO detail/edit drawer):
  - Add **Close** button, visible when `status ∈ {Draft, Shipped,
    Awaiting payment}` and `role === 'manager'`. Render as a muted /
    secondary action next to the status-advance and Archive controls —
    close is the off-ramp.
  - Add **Reopen** button, visible when `status === 'Closed'`. Opens a
    small confirm dialog with a required note. Submits `{ to: 'Draft',
    note }`.
  - Closed-status detail view:
    - Status chip = seeded `tone='muted'`, label `Closed`.
    - Header strip shows `Closed — <reason label> · <note preview>`. Full
      note + attachments live in the existing status-meta panel keyed by
      `status='Closed'`.
    - All edit affordances (lines, customer, status-advance) disabled,
      matching how Done is handled. Reopen is the only enabled action.

- **Existing: `DesktopSellOrders.tsx`** (list):
  - Filter chip row: add `Closed` after `Done`.
  - Pencil-edit button visibility currently `o.status !== 'Done'` →
    broaden to `o.status !== 'Done' && o.status !== 'Closed'`.

### i18n

All copy through `useT()`. Keys: `so.close.button`, `so.close.dialog.title`,
`so.close.dialog.reasonLabel`, `so.close.dialog.noteLabel`,
`so.close.dialog.submit`, `so.reopen.button`, `so.reopen.dialog.title`,
`so.reopen.dialog.noteLabel`, `so.reopen.dialog.submit`. Reason labels
come from the server (lookup `label`), no i18n key needed.

## Tests

Backend integration tests against real Postgres (per repo convention).
New file: `apps/backend/tests/sellOrders-close.test.ts`, layout
mirroring `orders-role-preview.test.ts`.

Cases:

1. Close Draft → Closed: succeeds with reason + note; status persists;
   `sell_order_events` row written with `kind='closed'`, `detail` carries
   `reasonId`, `note`, `fromStatus='Draft'`.
2. Close Shipped → Closed: succeeds; the underlying inventory line is
   then accepted onto a new Draft SO (proves soft-commit release).
3. Close Awaiting payment → Closed: succeeds.
4. Close Done → Closed: `409` illegal transition (Done's allowed set
   empty).
5. Close without `closeReasonId`: `400`.
6. Close with unknown `closeReasonId`: `400`.
7. Close with inactive `closeReasonId`: `400`.
8. Close without note: `400` (evidence gate).
9. Closed → Shipped: `409` illegal transition (Closed only goes to
   Draft).
10. Reopen Closed → Draft: succeeds; `close_reason_id` cleared;
    `sell_order_events` row with `kind='reopened'`; the Draft then
    advances to Shipped normally.
11. Reopen without note: `400`.
12. Non-manager close: `403`.
13. Concurrent close + status-advance on the same row: only one wins
    (FOR UPDATE serializes; second request sees the new state).

Frontend: one pure-helper test for `allowedNextStatuses(current):
string[]` derived from the transition map. UI behavior validated by
manual browser smoke per repo norms (frontend tests are sparse).

## Rollout

Single PR:

1. Migration `0053_sell_order_close.sql`.
2. Seed update (`seed.mjs`) for `sell_order_statuses` and
   `sell_order_close_reasons`.
3. Backend route + lookups extension + tests (TDD: red → green).
4. Frontend dialog + buttons + chip + reopen flow.
5. Manual smoke on dev: create SO → advance to Shipped → close → confirm
   the inventory line accepts onto a new Draft SO → reopen → advance to
   Done.

## Risks & notes

- **CHECK-constraint replacement** takes a brief table-level lock.
  `sell_orders` is small (low thousands); existing rows pass the new
  superset constraint. Acceptable.
- **Transition map is the single source of truth.** Future status
  additions edit one map — no parallel guard tables (CLAUDE.md
  convention).
- **Conditional evidence rule for reopen** is the one context-aware
  branch in the handler. Comment the *why* on the gate; tests #10 and
  #11 cover the truth table.
- **No mobile changes** — SO list is desktop-only today. If mobile
  surfaces SOs later, the chip/filter additions port over.
