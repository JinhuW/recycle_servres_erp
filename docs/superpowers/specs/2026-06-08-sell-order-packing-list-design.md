# Sell Order Packing List — Design

**Date:** 2026-06-08
**Status:** Approved

## Problem

Warehouse staff need a simple, printable document to pick and pack the items
of a sell order. Sell orders today have only an XLSX **list** export
(`GET /api/sell-orders/export`) and no per-order document. Purchase orders
already have a per-order commercial-invoice PDF (`GET /api/orders/:id/invoice`,
built by `lib/pdf.ts → buildPoInvoicePdf`); there is no equivalent for sell
orders, and an invoice is the wrong document for packing (it leads with money,
not with what/where/how-many).

## Goal

A per-sell-order, printable **packing list** PDF: price-free, grouped by
warehouse, with large readable rows and a checkbox to tick off packed items.

## Non-Goals

- No bulk / list-level packing document (the schema has no bin/shelf location;
  packing happens one order at a time at the bench).
- No prices, totals, currency, or FX anywhere on the document.
- No new location granularity — warehouse short code is the only location.

## Backend

### Endpoint

`GET /api/sell-orders/:id/packing-list` in `apps/backend/src/routes/sellOrders.ts`.

- Manager-only, consistent with every other route in the file (`u.role !==
  'manager'` → 403).
- 404 when the sell order id does not exist.
- Available for any order status.
- Returns a PDF via `pdfResponse(buf, \`${id}-packing-list.pdf\`)`.
- Mirrors the existing PO invoice endpoint (`routes/orders.ts:345`).

### Data

Reuse the head + line query already used by `GET /api/sell-orders/:id`:
`sol.label`, `sol.sub_label`, `sol.part_number`, `sol.qty`, and
`w.short AS warehouse_short` (LEFT JOIN `warehouses`). The customer name/short
and `created_at` come from the head row. No price columns are read.

### PDF builder

New function in `apps/backend/src/lib/pdf.ts`:

```
export function buildSellOrderPackingListPdf(d: PackingListData): Promise<Buffer>
```

Reuses `renderPdfToBuffer` and `loadInvoiceLogo` (same as the invoice builder).

Layout:

- **Header band:** logo, title "Packing List", sell-order id, customer
  name/short, created date.
- **Sections grouped by warehouse:** one section per `warehouse_short`. Lines
  with no warehouse fall into an "Unassigned" section that sorts last; other
  sections sort by warehouse code. Each section header shows the warehouse
  code.
- **Per-line columns:** `Packed ☐` · `Qty` · `Item` (label + sub-label) ·
  `Part #`. The packed column is an empty checkbox glyph to tick off by hand.
- No prices, totals, or currency.

Grouping is done in JS over the line rows (no SQL grouping change).

## Frontend

- A **"Packing list"** download button in the `SellOrderDetail` modal footer in
  `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` (alongside
  *Edit order* / *Archive*, ~line 979).
- Calls `api.download(\`/api/sell-orders/${id}/packing-list\`,
  \`${id}-packing-list.pdf\`)` — the same helper as the XLSX export, so CSRF
  exemption and refresh single-flighting are handled.
- Button label via `useT()`; add the key to both EN and ZH catalogs in
  `lib/i18n.tsx`. Download icon.

## Tests

Backend integration test (`apps/backend/tests/`):

- 200 + `Content-Type: application/pdf` for a real sell order with lines across
  two warehouses.
- 404 for an unknown id.
- 403 for a non-manager.

## Release

Ships as its own SemVer release via `scripts/release.sh` with a CHANGELOG
entry, per the repo's one-release-per-change convention.
