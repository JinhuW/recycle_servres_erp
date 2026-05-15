# Inventory Receive / Transfers Page — Design

Date: 2026-05-15
Status: Approved (Approach A)

## Problem

The inventory transfer flow is asymmetric. A manager can bulk-transfer
`Reviewing`/`Done` lines to another warehouse via the Transfer modal
(`POST /api/inventory/transfer`), which forces every moved line to
`status = 'In Transit'`. There is **no operation to bring inventory back
out of `In Transit`**:

- The transfer endpoint only ever writes `In Transit`; nothing transitions
  lines out of it.
- `isSellable()` (`apps/frontend/src/lib/status.ts:41`) is false for
  `In Transit`, so a transferred line silently disappears from sell-order
  eligibility until someone manually edits it.
- The only path back to a sellable status is the generic per-line edit
  dialog (`PATCH /api/inventory/:id`) — one row at a time, no dedicated
  action, no visibility into what is inbound.

A receiving manager has no surface that says "these arrived, mark them
ready", and no way to see in-transit items grouped by their origin and
destination.

## Decisions (locked with user)

| Question | Decision |
|---|---|
| Status received lines land on | Always `Done` |
| Who can receive | Manager only (consistent with Transfer) |
| Surface | Dedicated `/transfers` page |
| Export | CSV download, generated client-side |

## Approach

**A — Dedicated Transfers page + thin receive endpoint.** A new
manager-only `/transfers` page lists all `In Transit` lines enriched with
their from→to (pulled from the latest `transferred` audit event), supports
bulk "Confirm received" → `Done`, and a client-side CSV export of the
loaded rows. Mirrors the existing Transfer modal/endpoint patterns.

Rejected:
- **B — Incoming filter on Inventory page.** Less code, but the user chose
  a dedicated page and the Inventory list cannot cleanly show the from→to
  batch grouping.
- **C — Server-rendered CSV endpoint.** Robust for >200 rows, but the API
  client sends a bearer token so a plain download link needs extra auth
  plumbing; not worth it while list endpoints cap at 200 rows.

## Design

### Backend (`apps/backend/src/routes/inventory.ts`)

1. **`GET /api/inventory/transfers`** — manager-only (`u.role !== 'manager'`
   → 403). Returns `In Transit` lines **inner-joined** to their most recent
   `kind = 'transferred'` `inventory_events` row. The inner join is
   load-bearing: `In Transit` is also the *default* status for
   freshly-submitted purchases (migration `0001`), and those must NOT
   appear here — only lines that are in transit *because of a transfer*
   (i.e. have a `transferred` event) qualify. Exposes: line id, item
   identity fields (category, brand, capacity, type, description,
   part_number, etc.), qty, `from` (from the event `detail.from`) →
   `to` (the line's effective warehouse =
   `COALESCE(l.warehouse_id, o.warehouse_id)`), `transferred_at`
   (event `created_at`), `note` (event `detail.note`), and actor
   name/initials. Newest first, `LIMIT 200`. Cost fields are manager-only
   anyway since the route is manager-gated.

2. **`POST /api/inventory/receive`** — manager-only. Body `{ ids: string[] }`
   (non-empty array of string line ids; validate shape like `/transfer`
   does). Load the lines; if any is missing or `status !== 'In Transit'`,
   return 400 and abort the whole batch (all-or-nothing, single
   `sql.begin` transaction, same style as `/transfer`). A line with no
   prior `transferred` event is not specifically rejected — the
   `In Transit` status check is the guard, and the Transfers page only
   ever offers genuinely-transferred lines for selection. For each line:
   set `status = 'Done'`, and insert one `inventory_events` row with
   `kind = 'received'` and `detail = { at: <effective warehouse>, ... }`.
   Response: `{ ok: true, ids: string[] }`.

### Frontend

3. **New page `apps/frontend/src/pages/desktop/DesktopTransfers.tsx`.**
   Fetches `GET /api/inventory/transfers`. Renders a table of in-transit
   lines grouped under `from → to` batch headers. Each row has a checkbox.
   A "Confirm received" bulk button (with a selected-count badge, styled
   like the Transfer button) calls `POST /api/inventory/receive` with the
   selected ids, then refetches and toasts. An "Export CSV" button
   serializes the currently loaded rows (columns: item, qty, from, to,
   transferred date, note, actor) into a CSV string and triggers a
   download via a `Blob` + object URL. Empty state when no in-transit
   lines.

4. **Routing / nav wiring:**
   - `apps/frontend/src/lib/route.ts`: add `transfers: '/transfers'` to
     `DESKTOP_VIEW_TO_PATH`; add a `path === '/transfers'` branch to
     `pathToDesktopView`.
   - `apps/frontend/src/components/Sidebar.tsx`: add `'transfers'` to the
     `DesktopView` union and a manager-only `NAV` entry
     (`icon: 'truck'`, `roles: ['manager']`, `tKey: 'nav_transfers'`).
   - `apps/frontend/src/DesktopApp.tsx`: render `<DesktopTransfers />`
     when `view2 === 'transfers'`; include `transfers` in the
     purchaser-redirect guard (manager-only views).

5. **Activity drawer** (`apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx`):
   add a `received` event kind to the renderer — icon `check`, tone `pos`,
   label "Received".

6. **i18n** (`apps/frontend/src/lib/i18n.tsx`): add the new nav + page
   strings (`nav_transfers`, page title/subtitle, column headers,
   confirm/export button labels, empty state, toasts) to **both** the
   `en` and `zh` maps.

7. **Stale copy fix** (`apps/frontend/src/pages/desktop/DesktopInventory.tsx:267`):
   replace "Select rows in Ready or Selling status." with copy that names
   the real statuses (`Reviewing` / `Done`).

### Data flow

```
Transfer (existing):  line → In Transit  + 'transferred' event {from,to,qty,note}
Transfers page (new): GET /transfers → In Transit lines + their latest
                      'transferred' event → render grouped by from→to
Receive (new):        POST /receive {ids} → line → Done + 'received' event
                      → line is sellable again; round trip is symmetric
                        and fully auditable
```

## Out of scope (YAGNI)

- Partial-quantity receive (partials are already split into separate lines
  at transfer time; you receive whole in-transit lines).
- Purchaser / non-manager self-receive.
- Printable / packing-manifest export.
- Server-side CSV endpoint.

## Testing

- Backend: `/receive` happy path (In Transit → Done + event); rejects a
  batch containing a non-`In Transit` or missing line (no partial writes);
  403 for non-manager. `/transfers` returns enriched from→to rows;
  403 for non-manager.
- Frontend: page renders grouped rows; select + confirm refetches and the
  row disappears; CSV export produces the expected columns; empty state.
