# Product-grouped inventory — design

**Date:** 2026-05-18
**Status:** Approved (design), pending implementation plan

## Problem

The inventory model is line-centric. Every PO submission creates an `orders`
row plus one or more `order_lines` rows, and the inventory list shows one row
per `order_line`. The same physical product, bought on three different POs,
appears as three unrelated rows. To users this "does not make sense" — they
expect to see one entry per product, identified by its part number, and drill
into the individual purchases underneath.

Product-level grouping already exists, but only as scattered read-only
overlays (the QuickView modal and the edit page's "stock across warehouses"
card), each re-deriving the grouping client-side. There is no product-first
browse experience.

## Constraint that shapes the design

A PO line is a **lot**. It carries its own `unit_cost`, `sell_price`,
`condition`, `health`, `status`, and effective `warehouse`. Existing
`sell_order_lines.inventory_id` and `transfer_order` linkage reference specific
line IDs. Two POs of the same part number at different prices are two distinct
lots with distinct cost bases and distinct profit.

Therefore "make inventory unique by part number" is implemented as a
**presentation + grouping layer over the existing lot model**, not a physical
collapse of rows. No destructive merge: per-PO cost history, sell-order links,
and per-lot condition/status/warehouse are all preserved.

## Decisions (locked)

1. **Grouping layer, not data migration.** No schema changes. `order_lines`
   stays the lot record. All existing per-lot endpoints and workflows are
   untouched.
2. **PN-less lines → singleton groups.** Items with a null/empty part number
   are not grouped; each renders as its own row exactly as today. Only lines
   with a real part number collapse into product groups.
3. **Canonical part number is the group key.** Same canonicalization already
   used by `/events/by-part` and the frontend `canonicalPartNumber()`.
4. **Scope: desktop inventory list only** for the first pass. Phone inventory
   page, dashboard, and submit flow are out of scope.

## Architecture

### Backend

**`apps/backend/src/lib/part-number.ts` (new).**
Extract the canonical-part-number SQL fragment currently inlined in
`inventory.get('/events/by-part')` into one shared helper. Exports the SQL
fragment builder (column-canon and arg-canon) so the new products endpoint and
the existing events endpoint share one definition and cannot drift. Kept in
lockstep with frontend `canonicalPartNumber()` (`frontend/src/lib/format.ts`)
and the scan-time rule in `ai/normalize.ts`.

`/events/by-part` is refactored to consume the helper (behavior unchanged).

**`GET /api/inventory/products` (new handler in `inventory.ts`).**
Same query base, filters (`category`, `status`, `warehouse`, `q`), purchaser
vs. manager scoping, and cost-stripping rule as the existing
`inventory.get('/')` list. Loads the scoped lines, groups them server-side by
canonical part number (PN-less → singleton keyed by line id), and returns one
row per group:

- Aggregates: `qty` total, qty-by-status (in transit / in stock /
  reviewing), lot count, distinct-PO count, `unitCost` min/max/weighted-avg
  (**manager only** — stripped for purchasers, same rule as the list),
  representative `sellPrice`, warehouse chips (distinct effective warehouse
  shorts), newest `created_at`, distinct submitter(s).
- Representative spec (category, brand, capacity, generation, type,
  interface, form_factor, description, rpm) from the most recent lot, plus a
  `mixedSpec: boolean` flag when specs diverge across lots in the group.
- `lines[]`: every lot in the group with line id, order/PO id, date,
  submitter, `unitCost` (manager only), condition, health, effective
  warehouse, qty, status. Embedded in the same response — single round trip,
  no N+1.
- The 200-row cap applies to **groups**, not raw lines.

Untouched: `GET /:id`, `PATCH /:id`, `POST /transfer`, `/events/by-part`
(behavior), `/:id/sell-orders`, transfer-order endpoints. Every per-lot
workflow keeps working unchanged.

### Frontend (`apps/frontend/src/pages/desktop/DesktopInventory.tsx`)

- **Default = grouped view.** One row per product: label/spec, part number,
  total qty with status dots, warehouse chips, "N lots · M POs", cost range
  and aggregate profit (manager only), representative sell price.
- **Expand (row click / chevron) → inline per-PO sub-table** — the dropdown
  the user described. One sub-row per lot: PO id (link), date, submitter,
  cost, condition/health, warehouse, qty, status, with the existing
  quick-view and edit actions, each still targeting the specific line id.
- **Grouped ⇄ Flat toggle**, persisted via the same user-preferences
  mechanism as column visibility. Flat renders today's per-lot table
  verbatim, preserving bulk-select → create sell order / transfer unchanged.
- **Selection is lot-level.** Group header checkbox selects all sellable
  lots in that group; expanded lot rows carry their own checkboxes. The
  snapshot-into-draft behavior for sell order / transfer is unchanged.
- QuickView (already product-aware) is reachable from the product row.
- Extract the expandable group into a new `InventoryProductTable` component;
  `DesktopInventory.tsx` is already large and this keeps it focused.

### Data flow

1. Grouped view → `GET /api/inventory/products?<filters>` →
   `{ products: [{ ...aggregates, lines: [...] }] }`.
2. Render product rows; expand toggles visibility of embedded `lines` (no
   extra fetch).
3. Quick-view / edit / transfer / sell-order continue to use line IDs against
   the existing untouched endpoints.
4. Flat toggle → existing `GET /api/inventory` + today's table code path.

### Error handling / edge cases

- Diverging specs in a group → representative spec + subtle "mixed"
  indicator; lot sub-rows show their own specs.
- Purchaser cost-stripping applies to aggregates too (no min/max/avg cost, no
  profit), reusing the existing strip logic; grouping happens *after*
  purchaser scoping so a purchaser never sees another buyer's lots.
- Null/empty part number → singleton group keyed by line id.
- 200-group cap documented in the handler.

## Testing

- **Backend** (`apps/backend/tests/inventory-products.test.ts`, new):
  sloppy PN variants merge into one group; null PN → singletons; purchaser
  scoping + cost stripping on aggregates and lots; qty/status aggregation;
  filter passthrough (category/status/warehouse/q).
- **Shared canonical-PN helper**: parity test asserting it matches the
  frontend `canonicalPartNumber()` cases (extend/align with existing
  `normalize.test.ts`).
- **Frontend**: type-check; render check of grouped → expand if test infra
  permits.

## Components / boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `lib/part-number.ts` | Canonical-PN SQL fragment + helper | `getDb` sql tag |
| `inventory.get('/products')` | Scoped, filtered, grouped product list | part-number helper, settings, scoping |
| `InventoryProductTable` (frontend) | Render grouped rows + expandable lot sub-table | products API, QuickView, edit nav |
| `DesktopInventory` | View toggle, filters, selection orchestration | products + legacy list APIs |

## Out of scope (first pass)

Phone `Inventory` page, dashboard aggregates, submit/scan flow. Candidates for
a follow-up once the desktop product view is validated.
