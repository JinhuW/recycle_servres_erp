# Add inventory to an existing sell order

**Date:** 2026-06-10
**Status:** Approved — ready for implementation plan

## Problem

The sell-order edit modal (`apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`)
lets a manager change line qty / unit price, re-pick the customer/currency, and
**remove** lines. There is no way to **append new inventory lines** to an
existing order. Today the only path to add more stock is to create a brand-new
sell order from the inventory page.

The backend already supports a larger line set: `PATCH /api/sell-orders/:id`
rewrites lines wholesale (DELETE + re-INSERT), re-runs `validateSellLines` with
`excludeOrderId` (so the order keeps its own already-committed lots), re-snapshots
FX, and auto-classifies the diff into `line_added` / `line_removed` /
`line_edited` audit events via `diffSellOrderLines`. So this is almost entirely a
frontend job plus one read endpoint.

## Scope

In scope:

- A `+ Add inventory` action in the edit modal that opens an inventory picker.
- A picker that lists currently-sellable lots grouped by product number, with
  search, and appends the selected lots as new lines to the in-memory edit draft.
- One new read-only REST endpoint backing the picker.

Out of scope (YAGNI):

- Manual (non-inventory) ad-hoc lines.
- An entry point from the inventory page ("add selected lots to order X").
- Market / last-sold price prefill.

## Workflow

1. Manager opens an existing non-`Done` sell order in **edit** mode.
2. Clicks **`+ Add inventory`** in the lines section.
3. The picker modal opens over the edit modal, listing sellable lots grouped by
   product number, with a search box.
4. Manager checks one or more lots, clicks **`Add N lines`**.
5. Each selected lot is appended to `draft.lines` as a new editable line.
6. Manager adjusts qty / price as needed and clicks the modal's existing
   **Save**, which PATCHes the full line set. New lots persist and emit
   `line_added` events.

## Design

### 1. Entry point

In the edit modal's lines section, add a `+ Add inventory` button. Visible only
when `mode === 'edit'` and `status !== 'Done'` (line edits are already locked for
Done orders both client- and server-side).

### 2. Read endpoint — `GET /api/sell-orders/sellable-inventory`

- Manager-only (same guard as the rest of the mutating sell-order surface uses
  for role checks; this endpoint is read-only but manager-scoped).
- Query params: `q` (free-text), `warehouseId` (optional filter). No
  `excludeOrderId` needed — see below.
- Returns lots with `status IN ('Reviewing','Done')` that are **not on any open
  sell order** (`so.status NOT IN ('Done','Closed')`). Because the order being
  edited is itself open, this filter already hides its own lots from the picker,
  which is the desired behavior.
- Response shape carries everything needed to build an edit line:
  `inventoryId, category, label, subLabel, partNumber, condition, warehouseId,
  warehouseName, availableQty, sellPrice`.

**Avoid SQL drift.** The MCP tool `search_sellable_inventory`
(`apps/backend/src/mcp/tools/sellOrders.ts`) already runs exactly this query.
Extract it into a shared `apps/backend/src/services/sellableInventory.ts` and
have both the MCP tool and the new REST route call it. The MCP tool keeps its
own argument parsing / output mapping; only the SQL moves.

### 3. Picker component — `apps/frontend/src/components/AddInventoryPicker.tsx`

A modal layered over the edit modal:

- Fetches from the new endpoint via `lib/api.ts` (never raw `fetch`).
- **Grouped by product number**: each `part_number` is a group header; lots with
  no part number fall back to grouping by `label + condition`. Under each group,
  one row per physical lot showing warehouse · available qty · suggested sell
  price · a checkbox.
- A search box re-queries the endpoint (or filters client-side) by brand /
  part# / description / category.
- Footer: `Add N lines` (disabled when nothing selected) and Cancel.
- All copy via `useT()`; no raw English in JSX.

### 4. Merge into the draft

On confirm, map each selected lot to a new `EditLine` appended to `draft.lines`:

- **qty** → the lot's full `availableQty` (mirrors the new-order builder, which
  defaults qty to the max sellable quantity).
- **unitPrice** → if `draft.lines` already contains a line for the same product
  (`productKey = partNumber|label|condition`), reuse that line's `unitPrice`;
  otherwise `0`. This rides the modal's existing per-product price-sync
  (`setProductPrice` / `productKey`), so all lots of one product stay in
  lockstep.
- `inventoryId`, `category`, `label`, `subLabel`, `partNumber`, `condition`,
  `warehouseId` copied from the lot.

Appended lines slot straight into the existing warehouse-grouped edit view
(`editGroups`), which already keys mutations by flat-array index. No layout
changes beyond the new button.

### 5. Save & validation

Unchanged. The modal's existing Save sends the full `draft.lines` via
`PATCH /:id`. The larger set is re-validated (`validateSellLines` with the
current order as `excludeOrderId`), persisted, and each new lot produces one
`line_added` event. If another order claimed a lot between picking and saving,
the existing 400 (`inventory line … is already on an open sell order`) surfaces
in the modal's current error banner.

## Data flow

```
Inventory lots (order_lines, status Reviewing/Done, not on an open SO)
        │  GET /api/sell-orders/sellable-inventory  (shared sellableInventory query)
        ▼
AddInventoryPicker  ── select lots ──▶  append EditLines to draft.lines
        │                                        │
        │                                        ▼
        └────────────────────────────▶  edit modal Save  ──PATCH /:id──▶
                                          validateSellLines + line-rewrite + line_added events
```

## Error handling

- **Lot grabbed concurrently:** existing PATCH 400, shown in the modal banner.
- **Done order:** button hidden; PATCH also rejects structural edits to a Done
  order with 409 as a backstop.
- **Empty picker result:** picker shows an empty state ("no sellable inventory").

## Testing

- **Backend integration** (real Postgres, per existing conventions):
  - `GET /sellable-inventory` returns only sellable lots, excludes lots on an
    open sell order, honors `q` and `warehouseId`, and is manager-only.
  - `PATCH /:id` with appended inventory lines persists them and writes one
    `line_added` event per new lot (extend existing sell-order PATCH/events
    coverage).
- **Frontend:** UI behavior validated by visiting it; add a unit test only if a
  non-trivial pure helper emerges (e.g. the product-grouping function). Per repo
  convention, frontend tests stay sparse.

## Files touched

- `apps/backend/src/services/sellableInventory.ts` — **new**, extracted query.
- `apps/backend/src/mcp/tools/sellOrders.ts` — call the shared query.
- `apps/backend/src/routes/sellOrders.ts` — new `GET /sellable-inventory` route.
- `apps/frontend/src/components/AddInventoryPicker.tsx` — **new** picker modal.
- `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` — `+ Add inventory`
  button + merge logic.
- `apps/frontend/src/lib/i18n.tsx` — EN + ZH strings.
- Backend test files for the endpoint + PATCH-append coverage.
