# Product-Centric Changelog & Edit — Design

**Date:** 2026-05-19
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

The inventory changelog (`inventory_events`) is recorded per **PO line** and
surfaced three ways: a workspace-wide Activity drawer, a per-line edit history,
and a "Change log across part number" block buried inside the Quick View modal.
The edit page also loads a single PO line by id and only PATCHes that line, even
though it *presents* aggregated peer data ("Aggregated by part number across N
lines").

The mental model across the app is already **product = canonical part number**,
but neither the changelog nor the edit write-path follows that model. We want a
product-centric view: a product detail drawer with the changelog as its
centerpiece (every entry attributed to its source PO + quantity), and
product-scoped editing for managers.

## Goals

1. Resurface the per-product changelog as the centerpiece of a **Product Detail
   drawer** that replaces the existing Quick View modal.
2. Every changelog entry shows its source **PO (clickable chip) + quantity**.
3. Make spec/sell-price edits **product-scoped** (manager-only): one save
   propagates to every lot of that part number.

## Non-Goals (YAGNI)

- No new event kinds.
- No qty-at-time-of-event snapshotting (use the line `qty` or `detail` qty).
- No collapsible group-by-PO timeline mode (flat timeline + PO chips only).
- No dedicated product route/page (drawer only).
- `qty` / `unit_cost` / `status` semantics unchanged — they remain per-PO-lot.
- No purchaser product-wide edits (manager-only).

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Grouping unit | Canonical part number (existing rule) |
| Changelog content | Full audit, all event kinds, resurfaced per product |
| Placement | Product detail drawer that **replaces** Quick View |
| Entry format | PO chip + qty on **every** entry |
| Edit scope | Specs **and** sell price product-wide; qty/unit_cost/status stay per-lot |
| Permissions | **Manager-only** product edit, touches **all lots**; purchasers keep per-line edit on own lots |
| Audit recording | **Per-lot event + UI collapse** of identical simultaneous events |

## Architecture

Approach **A — Reuse + augment**. No migration. Reuse the existing canonical
part-number matching (`canonPartCol` / `canonPartArg`), `/api/inventory/products`
(merged specs, lots, qty-by-status, `po_count`), and `/aggregate/by-part`.

### Backend

**1. Augment `GET /api/inventory/events/by-part`**

Add `o.id AS order_id` and `l.qty` to the SELECT. Everything else (canonical
matching, manager/purchaser scoping, 200-row cap, ordering) is unchanged. This
gives the changelog UI the source PO and quantity for every entry.

**2. New endpoint `PATCH /api/inventory/product` (manager-only)**

- Returns **403** for non-managers.
- Body: `{ partNumber, ...specFields, sellPrice? }` where spec fields are the
  product-identity columns (category, brand, capacity, generation/type, speed,
  interface, form_factor, description, and a new `partNumber`). Only provided
  fields are written.
- Resolves all `order_lines` whose canonical part number matches
  `canonPartArg(partNumber)`.
- In a single transaction:
  - `UPDATE` the provided spec fields and `sell_price` on **every** matched lot.
  - `qty`, `unit_cost`, `status` are **never** touched.
  - For each affected lot, insert `inventory_events` rows following the existing
    per-line PATCH convention: `priced` for a sell-price change, one `edited`
    row per changed spec field (`detail = { field, from, to }`). All rows in the
    transaction share the same `actor_id` and `created_at` so the UI can collapse
    them.
- If `part_number` itself changes, all matched lots are re-stamped together in
  the same transaction, so canonical grouping stays consistent.
- The existing sell-order guard (blocks `qty`/`status` changes on lots committed
  to an open sell order) is unaffected — product edit never changes `qty`/
  `status`; product-wide `sell_price` changes are allowed.

**3. Existing per-line `PATCH /api/inventory/:id` is unchanged** — purchasers
keep editing their own lots' `qty` / `unit_cost` / `status` / specs through it.

### Frontend

**A. Product Detail drawer (replaces `InventoryQuickView` in DesktopInventory.tsx)**

Same trigger points as today's Quick View (the "Quick view" buttons in the flat
and grouped tables). Right-side drawer keyed on canonical part number. Sections
top → bottom:

1. **Header** — canonical part number, category icon, merged spec chips,
   `mixed_spec` warning when specs vary across lots.
2. **Stock summary** — in transit / in stock / reviewing / total, PO count,
   avg unit cost (manager only, same gating as today).
3. **Lots by PO** — each lot row: qty + clickable PO chip + status (from the
   `/products` payload).
4. **Changelog (centerpiece)** — timeline from `/events/by-part`, newest first.
   Each entry: kind icon, summary text, clickable **PO chip + qty**, actor name
   (or "system"), relative time. Entry templates:
   - `created` → "Added {qty} units" · PO chip
   - `sold` → "Sold {qty}" · PO chip
   - `transferred` → "Transferred {qty} → {warehouse}" · PO chip
   - `status` → "Status → {to}" · PO chip
   - `priced` → "Sell price → ${amt}" · PO chip
   - `edited` → "{field}: {from} → {to}" · PO chip
   - `received` → "Received at {warehouse}" · PO chip
   - `reopened` → "Transfer re-opened" · PO chip
   - PO chip click → navigates to the existing order view.
   - **UI collapse:** consecutive events with the same `kind` + `detail`
     (field/from/to, or price) + actor + `created_at` truncated to the second
     render as one entry, e.g. "Sell price → $75 · applied to 6 lots", listing
     the affected PO chips (or "N lots" when many).

The old Quick View modal and its buried changelog block are removed.

**B. Edit page becomes product-scoped for managers (DesktopInventoryEdit.tsx)**

- The spec + sell-price form saves via `PATCH /api/inventory/product`
  (product-wide) when the user is a manager — aligning the write with the
  aggregated peer data the page already shows.
- `qty` / `unit_cost` / `status` keep their existing per-lot controls (existing
  per-line `PATCH /api/inventory/:id`), since each PO lot owns those values.
- Purchasers: unchanged — per-line edit on their own line only.

## Data Flow

```
Quick view / edit entry point
        │  canonical part number
        ▼
GET /api/inventory/products        → header, specs, stock, lots by PO
GET /api/inventory/events/by-part   → changelog (now incl. order_id + qty)
        │
        ▼
Product Detail drawer (changelog centerpiece, collapsed per-lot events)
        │
        ├─ PO chip click ───────────→ existing order view
        └─ manager edits specs/price → PATCH /api/inventory/product
                                         → updates all lots' specs+sell_price
                                         → writes per-lot inventory_events
                                         → drawer changelog collapses them
```

## Error Handling

- `PATCH /api/inventory/product` by a non-manager → **403**.
- Missing/blank `partNumber` → **400** (consistent with `/events/by-part`).
- No lots match the canonical part number → **404** (nothing to update).
- Sell-order guard remains for `qty`/`status` on the per-line PATCH; not
  triggered by product edit (it never changes those fields).
- All product-edit writes happen in one transaction — partial propagation is
  not possible.

## Testing

**Backend (vitest):**
- `/events/by-part` returns `order_id` and `qty` for each event.
- Manager `PATCH /api/inventory/product` updates specs + sell_price on **all**
  lots of the part number, writes one `inventory_events` row per affected lot,
  and leaves `qty` / `unit_cost` / `status` untouched.
- Purchaser `PATCH /api/inventory/product` → 403.
- Changing `part_number` re-stamps all lots so they still group together.

**Frontend (manual, in browser):**
- Drawer opens from both the flat and grouped tables.
- Changelog renders with PO chips + qty; identical simultaneous per-lot events
  collapse into one row.
- PO chip navigates to the order view.
- Manager product edit propagates specs + sell price across lots; per-lot
  qty/cost/status controls still work.
- Purchaser still edits only their own line.
