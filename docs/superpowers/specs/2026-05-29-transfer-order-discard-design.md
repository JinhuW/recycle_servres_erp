# Transfer-Order Discard — Design

**Date:** 2026-05-29
**Status:** Approved (design)

## Problem

Managers can create transfer orders (TOs) that move inventory between
warehouses, then **Receive** them (Pending → Received) or **Reopen** them
(Received → Pending). There is no way to *cancel* a transfer that was created
by mistake. The only escape today is to receive it and live with the move, or
hand-edit the database.

We want a **Discard** action that undoes a Pending transfer: the moved goods go
back to their origin warehouse and the TO record is removed.

## Scope

- **Discard applies to Pending transfer orders only.** A Received TO must be
  **Reopened** first (it already drops back to Pending), then discarded. This
  mirrors the purchase-order rule "only Draft orders can be deleted" and keeps
  the state machine linear — we never reverse a receipt and a transfer in one
  step.
- Manager-only, like every other transfer endpoint.
- Hard delete of the `transfer_orders` row. Per-line `inventory_events`
  preserve the audit trail (the original `transferred` event stays; a new
  `transfer_discarded` event is appended), so deleting the grouping row loses
  nothing material — same trade-off as PO draft delete.

Out of scope: discarding Received TOs directly; soft-delete/"Discarded" status;
bulk discard.

## How a transfer moves inventory (recap)

From `inventory.ts` `POST /transfer`:

- **Full move** (`qty === line.qty`): the *existing* line is flipped in place —
  `warehouse_id = dest`, `status = 'In Transit'`, `transfer_order_id = TO`.
  Its `transferred` event detail is `{ from, to, qty, transfer_order_id }`
  with **no `peer_line_id`**.
- **Partial move** (`qty < line.qty`): the source line's `qty` is decremented
  and stays put (its `transfer_order_id` is left **NULL**); a **clone** is
  inserted at the destination with `status = 'In Transit'`,
  `transfer_order_id = TO`. Both lines get a `transferred` event whose detail
  **includes `peer_line_id`** pointing at the other.

Therefore, among the lines that satisfy `transfer_order_id = TO`:

| Line kind        | `transferred` detail | Reversal |
|------------------|----------------------|----------|
| Full-move original | no `peer_line_id`  | flip back in place |
| Partial clone      | has `peer_line_id` | merge into source, delete clone |

`peer_line_id` presence is the discriminator — no schema change needed to tell
them apart.

## Backend

### Endpoint

`DELETE /api/inventory/transfer-orders/:id` — manager-only. (DELETE verb to
match the "delete" intent and the PO precedent `DELETE /api/orders/:id`;
receive/reopen stay POST actions.)

Returns `{ ok: true, id }` on success. Error codes:

- `403` — non-manager.
- `404` — TO not found.
- `400` — TO is not Pending (`"transfer order TO-x is Received; reopen it
  before discarding"`).
- `409` — a line under the TO has moved on (status ≠ `In Transit`, or is
  referenced by a sell order). Message lists the offending line ids — same
  shape as the reopen guard.

### Transaction (all inside `sql.begin`, rows locked)

1. `SELECT … FROM transfer_orders WHERE id = :id FOR UPDATE`. 404 if missing;
   400 if `status <> 'Pending'`.
2. Load the TO's lines `FOR UPDATE OF l`, with a sell-order count:
   ```sql
   SELECT l.id, l.status, l.qty,
          (SELECT COUNT(*)::int FROM sell_order_lines sl
            WHERE sl.inventory_id = l.id) AS sell_count
     FROM order_lines l
    WHERE l.transfer_order_id = :id
    FOR UPDATE OF l
   ```
   Guard: every line must be `In Transit` with `sell_count = 0`, else `409`.
   (A line re-transferred to *another* TO had its `transfer_order_id`
   overwritten, so it won't appear here — intentionally not chased, exactly as
   reopen documents.)
3. Load each line's `transferred` event **for this TO** to recover `from`
   (origin warehouse) and `peer_line_id`:
   ```sql
   SELECT order_line_id, detail
     FROM inventory_events
    WHERE order_line_id = ANY(:lineIds::uuid[])
      AND kind = 'transferred'
      AND detail->>'transfer_order_id' = :id
   ```
   Build a map `lineId → { from, peerLineId }`. Origin falls back to the TO's
   `from_warehouse_id` when set (single-source TO); the event's `from` covers
   mixed-source TOs.
4. For each TO line `L`:
   - **Partial clone** (`peerLineId` present): look up the source peer `S`
     `FOR UPDATE`. If `S` exists, has `transfer_order_id IS NULL`, and isn't
     sold → `UPDATE order_lines SET qty = qty + L.qty WHERE id = S` and
     `DELETE FROM order_lines WHERE id = L` (its events cascade — `0002`
     declares `inventory_events.order_line_id … ON DELETE CASCADE`). Append a
     `transfer_discarded` event on `S`.
     If `S` is gone/sold/no-longer-a-remainder → **fallback**: revert `L` in
     place like a full move (below). Append the event on `L`.
   - **Full-move original** (`peerLineId` absent): revert in place —
     `UPDATE order_lines SET warehouse_id = :origin, status = 'Done',
     transfer_order_id = NULL WHERE id = L`. Append a `transfer_discarded`
     event on `L`.
5. `DELETE FROM transfer_orders WHERE id = :id`. By now no `order_lines`
   reference it (clones deleted, full-moves detached), so the implicit
   `RESTRICT` FK on `order_lines.transfer_order_id` is satisfied.

`transfer_discarded` event detail: `{ transfer_order_id, returned_to: origin,
qty }`.

### Restored status

Reverted lines (full-move originals and partial-clone fallbacks) are set to
`status = 'Done'`. Lines were `Reviewing` or `Done` before transfer (the create
guard requires it); their pre-transfer status isn't recorded today. `Done` is
the normal in-stock sellable state, so it's the safe restore target. To avoid
the (rare) `Reviewing → Done` loss, the create endpoint will additionally stamp
`prior_status` into the `transferred` event detail; discard reads it when
present and falls back to `'Done'` for in-flight/legacy transfers. Partial
clones merged back into `S` don't need this — `S` keeps its own status.

## Frontend

`pages/desktop/DesktopTransfers.tsx`:

- Add a **Discard** button (danger-styled, `btn danger`) next to *Confirm
  (receive)* on Pending rows only.
- Clicking opens a lightweight confirm modal (not the PO retype-id danger
  zone — a freshly-created Pending TO is low-stakes): title "Discard TO-x?",
  body "Its lines return to their origin warehouse and the transfer is
  removed.", Cancel / Discard. On confirm, call the API, toast, reload.
- `lib/api.ts`: add `discardTransferOrder = (id) =>
  api.delete<{ ok: true; id: string }>(\`/api/inventory/transfer-orders/${id}\`)`.

### i18n (`lib/i18n.tsx`, EN + ZH)

New keys: `transfersDiscard` (button), `transfersDiscardConfirmTitle`,
`transfersDiscardConfirmBody`, `transfersDiscarded` (success toast,
`{id}`-interpolated). Reuse existing `transfersActionError` for failures.

## Tests

`apps/backend/tests/transfer-orders.test.ts` (extend):

- Full-move discard: line returns to origin warehouse, `status = 'Done'`,
  `transfer_order_id` cleared; TO row gone.
- Partial-move discard: source line's `qty` restored to the original total,
  clone deleted; TO row gone.
- Partial-move discard with source consumed: clone reverts standalone at origin
  (fallback path) instead of erroring.
- Non-Pending TO → `400`.
- Line sold (sell_count > 0) → `409`, no mutation.
- Non-manager → `403`.

## Files touched

- `apps/backend/src/routes/inventory.ts` — new DELETE handler; add
  `prior_status` to the two `transferred` event details in `POST /transfer`.
- `apps/backend/tests/transfer-orders.test.ts` — discard cases.
- `apps/frontend/src/pages/desktop/DesktopTransfers.tsx` — button + confirm
  modal.
- `apps/frontend/src/lib/api.ts` — `discardTransferOrder`.
- `apps/frontend/src/lib/i18n.tsx` — EN + ZH keys.
