# Inventory Transfer — Design

**Status:** Approved
**Date:** 2026-05-14
**Surface:** Manager portal · Desktop Inventory page

## 1. Goal

Let a manager move inventory from one warehouse to another from the Inventory page. Supports bulk selection and partial-qty transfers. Reuses the existing audit log and "In Transit" status; no new pages.

## 2. Scope

In scope:

- Bulk transfer of selected inventory lines to a single destination warehouse.
- Per-line qty editing in the transfer modal (partial transfers split the source line).
- Audit trail entries on both source and destination lines.
- Activity-drawer integration (new kind filter + readable label).

Out of scope:

- New status value (reuse `In Transit`).
- Transfer-as-document view (no separate Transfers page).
- Purchaser-side affordance — manager-only.
- ETA / carrier / cost fields on transfers.
- Multi-destination per submission. To split across two destinations the manager runs the operation twice.

## 3. Eligibility & rules

- Only managers can transfer.
- A source line is eligible only when `status IN ('Reviewing','Done')` — i.e. the same rule already used by `isSellable`. Draft/In Transit lines are not yet physically present in a warehouse, so they cannot be transferred.
- `qty` to move must satisfy `1 ≤ qty ≤ line.qty` and be an integer.
- The destination warehouse must differ from the line's effective source warehouse (`COALESCE(line.warehouse_id, order.warehouse_id)`). The modal hides the source warehouses from the destination picker to make this impossible to violate.
- All lines in one submission move to the same destination.
- The whole submission is one transaction — any validation failure aborts every line.

## 4. Data model

### 4.1 Schema migration

File: `apps/backend/migrations/0010_inventory_transfer.sql`

```sql
ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS warehouse_id TEXT REFERENCES warehouses(id);
CREATE INDEX IF NOT EXISTS order_lines_warehouse_idx ON order_lines(warehouse_id);
```

`order_lines.warehouse_id` is **nullable** and acts as an override:

- `NULL` — line inherits its parent order's `warehouse_id` (current behavior; no backfill needed).
- non-NULL — line lives in that warehouse regardless of its parent order.

Effective warehouse of a line is therefore `COALESCE(l.warehouse_id, o.warehouse_id)`.

### 4.2 Audit events

`inventory_events.kind` is free-form `TEXT` — no migration. Transfer adds a new kind:

```jsonc
// kind = 'transferred'
// On the source line:
{ "from": "WH-BAY", "to": "WH-LAX", "qty": 5, "peer_line_id": "<dest-uuid>", "note": "consolidating SSD stock" }

// On the destination line (only present for partial transfers; full
// transfers reuse the source line and emit just one event):
{ "from": "WH-BAY", "to": "WH-LAX", "qty": 5, "peer_line_id": "<source-uuid>", "note": "consolidating SSD stock" }
```

`note` is omitted from the JSON when the user didn't supply one.

## 5. Backend

### 5.1 New route

`POST /api/inventory/transfer` (manager only).

Request body:

```jsonc
{
  "toWarehouseId": "WH-LAX",
  "note": "optional free-text, ≤200 chars",
  "lines": [
    { "id": "<line-uuid>", "qty": 5 },
    { "id": "<line-uuid>", "qty": 12 }
  ]
}
```

Validation (HTTP 400 on any failure, no rows touched):

- Body shape: `toWarehouseId` non-empty string; `lines` non-empty array; each entry has `id` (uuid) and `qty` (positive integer).
- `note`, if present, ≤200 chars after trim.
- All `lines[i].id` resolve to a real `order_lines` row.
- Every source line has `status IN ('Reviewing','Done')`.
- Every source line has `qty >= lines[i].qty`.
- Destination warehouse exists.
- Every line's effective source warehouse ≠ destination.

Per-line operation, inside `sql.begin`:

- **Full move** (`qty === line.qty`):
  - `UPDATE order_lines SET warehouse_id = $dest, status = 'In Transit' WHERE id = $id`.
  - One `inventory_events` row (`kind='transferred'`) on the same line. `peer_line_id` omitted.
- **Partial move** (`qty < line.qty`):
  - `UPDATE order_lines SET qty = qty - $n WHERE id = $id`. Status on the remainder is **unchanged**.
  - `INSERT` a clone under the same `order_id` carrying every spec column (category, brand, capacity, type, classification, rank, speed, interface, form_factor, description, part_number, condition, unit_cost, sell_price, health, rpm, scan_image_id, scan_confidence) with `qty=$n`, `warehouse_id=$dest`, `status='In Transit'`, `position` = source position.
  - Two `inventory_events` rows — one on source and one on the new line — both `kind='transferred'`, cross-referencing each other via `peer_line_id`.

Response:

```jsonc
{
  "ok": true,
  "lines": [
    { "sourceId": "...", "destId": "...", "qty": 5 }   // destId === sourceId for full moves
  ]
}
```

403 if the caller is not a manager. 400 on validation errors (single `error` string, same convention as other routes).

### 5.2 List query update

In `apps/backend/src/routes/inventory.ts`, the main `GET /` query and `GET /:id` both currently key warehouse off `o.warehouse_id`. Change to:

```sql
COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id
LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
```

The `warehouse` filter clause becomes `COALESCE(l.warehouse_id, o.warehouse_id) = $warehouse`.

No other routes need changing — `orders`, `sellOrders`, `dashboard`, `market` all read `orders.warehouse_id` for purchase-order context, which is the correct semantic for those surfaces (the original purchase happened at the original warehouse). Inventory and downstream sell-order line creation read the effective warehouse, which is what they need.

### 5.3 Sell-order line creation

`DesktopSellOrderDraft` carries `warehouseId` through to the backend. The current selection comes from the inventory row's `warehouse_id` field; since that field will now reflect `COALESCE`, sell orders built from transferred lines will correctly reference the destination warehouse. No additional change required.

## 6. Frontend

### 6.1 Entry points (`DesktopInventory.tsx`)

Manager-only additions:

- **Top toolbar** (`page-actions`): new `Transfer` button placed between `Activity log` and `Create sell order`. Disabled when `selectedItems.length === 0`. Mirrors the count badge pattern used by `Create sell order`.
- **Floating selection bar** (`sel-bar`): same `Transfer` button alongside `Create sell order`, for the case where the user has scrolled.

Both buttons call `openTransferModal()`, which snapshots `selectedItems` into a new state variable `transferItems` (mirrors the existing `draftItems` snapshot pattern).

No row-level icon button — bulk only, matching how Create sell order works.

### 6.2 Modal (`DesktopInventoryTransfer.tsx`)

New file. Same shell pattern as `DesktopSellOrderDraft`: centered modal, `onClose`/`onSaved` props, items snapshotted on open so further table changes don't mutate the modal.

Props:

```ts
type Props = {
  items: TransferItem[];           // snapshot of selected inventory rows
  warehouses: Warehouse[];         // for the destination picker
  onClose: () => void;
  onSaved: (n: number, destShort: string) => void;
};

type TransferItem = {
  id: string;
  label: string;
  subLabel: string | null;
  partNumber: string | null;
  qty: number;                     // current qty on the line
  warehouseId: string | null;      // effective source warehouse
  warehouseShort: string | null;
  category: 'RAM' | 'SSD' | 'HDD' | 'Other';
};
```

Internal state:

- `toWarehouseId: string | null` — submit disabled until set.
- `qty: Record<lineId, number>` — pre-filled with each item's full qty; clamped on input to `[1, item.qty]`.
- `note: string`.
- `submitting: boolean` + `error: string | null` for the API call.

Layout:

```
┌─ Transfer 3 lines ─────────────────────── × ┐
│                                              │
│  Destination warehouse                       │
│  [ Select warehouse ▾ ]   ← excludes any     │
│                             source ids       │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ ITEM                FROM   QTY       │    │
│  │ Samsung 16GB DDR4   BAY   [12]/12    │    │
│  │ Crucial 512GB SSD   LAX   [ 5]/12    │    │
│  │ Seagate 2TB HDD     BAY   [ 1]/1     │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  Note (optional)                             │
│  [ consolidating SSD stock_________________] │
│                                              │
│  ─────────────────────────────────────────── │
│                          [Cancel]  [Transfer]│
└──────────────────────────────────────────────┘
```

Destination picker: a `select` populated from `warehouses`, with any warehouse id present in `items` filtered out. Shows `short — region` per option.

Per-row qty input: numeric, min=1, max=item.qty, default=item.qty. Display "qty/max" inline so the cap is visible at a glance. Inline error styling if the value falls out of range; submit button disables while any qty is invalid.

Submit:

1. Build the request body from state.
2. `POST /api/inventory/transfer`.
3. On 200 → `onSaved(items.length, destShort)`, parent closes modal, clears selection, refetches inventory, fires toast `"Transferred N line(s) to <destShort>"`.
4. On error → show the server's `error` string in an inline banner above the footer; modal stays open so the user can adjust.

### 6.3 Activity drawer (`DesktopActivityDrawer.tsx`)

- Add `'transferred'` to the kind-filter dropdown (alongside created/status/priced/edited).
- Icon: `truck` (already used elsewhere for In Transit).
- Render: when `detail.from`, `detail.to`, `detail.qty` are present, show `"Transferred {qty} units · {from-short} → {to-short}"`. If the detail JSON doesn't match that shape (forward-compat / corrupt rows), fall back to `"Transferred"` with the raw JSON tucked into a tooltip — same defensive pattern the drawer already uses for other kinds.

The warehouse short labels need to be resolvable from id, which means the drawer needs the warehouse list. It already fetches it indirectly via the parent inventory page; pass `whs` down as a prop rather than re-fetching.

### 6.4 i18n

Add the visible strings to `apps/frontend/src/lib/i18n.tsx`:

- `transfer` — button label
- `transferTitle` — modal header (parameterised with the line count)
- `transferDestination` — "Destination warehouse"
- `transferNote` — "Note (optional)"
- `transferSubmit` — "Transfer"
- `transferredToast` — "Transferred {n} line(s) to {warehouse}"

Both `en` and `zh` translations land in this PR.

## 7. Permissions

- Backend: `POST /api/inventory/transfer` returns 403 if `user.role !== 'manager'`.
- Frontend: the Transfer buttons render only when `isManager` (mirrors `Create sell order`).

## 8. Testing

Backend (`apps/backend/tests/inventory.test.ts` — extend or new file):

- Manager: full-qty transfer flips `warehouse_id` and status on the same line, no new row created.
- Manager: partial-qty transfer decrements source qty, creates a new line at destination with status `In Transit`, copies spec columns, writes two `inventory_events` rows that reference each other.
- Manager: bulk submission of mixed full + partial transfers — all succeed in one transaction.
- Validation: `qty > line.qty` → 400, no rows touched.
- Validation: source status `Draft` or `In Transit` → 400.
- Validation: destination equals effective source → 400.
- Validation: unknown destination warehouse → 400.
- Atomicity: one invalid line in a multi-line submission rolls back every row.
- Permissions: purchaser → 403.

Frontend:

- Manual smoke against `pnpm --filter frontend dev`: select two lines from different source warehouses, transfer to a third, confirm both disappear from their source pills and reappear at the destination pill with `In Transit`. Run an `Activity log` filter on `transferred` and confirm the row renders correctly.
- TypeScript: `pnpm --filter frontend typecheck` passes.

## 9. File touch list

New:

- `apps/backend/migrations/0010_inventory_transfer.sql`
- `apps/frontend/src/pages/desktop/DesktopInventoryTransfer.tsx`

Modified:

- `apps/backend/src/routes/inventory.ts` — new route, `COALESCE` in list/detail queries.
- `apps/frontend/src/pages/desktop/DesktopInventory.tsx` — Transfer buttons, modal trigger, snapshot state.
- `apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx` — `'transferred'` kind support.
- `apps/frontend/src/lib/i18n.tsx` — new strings (en + zh).
- `apps/backend/tests/inventory.test.ts` — new test cases.
