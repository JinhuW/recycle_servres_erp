---
id: RS-242
title: Purchase orders list filters by warehouse and payment method
type: story
status: done
priority: P2
created: 2026-10-12
reporter: jinhu
branch: feat-payment-warehouse-filter
pr: 627
version: 1.252.0
related: []
---

## Ask

> Add a payment method + warehouse filter.
>
> Make sure you make a smooth filter on it
>
> (with a screenshot of the desktop Purchase orders list)

## Context

The desktop Purchase orders list (`pages/desktop/DesktopOrders.tsx`) filters
by category (segmented control), stage and Sold (the manager chip rail,
v1.246.0), Done and archived toggles, and a search box. Warehouse and
Payment are columns on every row but there is no way to narrow the list to
one warehouse or to Company- or Self-paid POs — the manager reconciling one
warehouse's intake, or the purchaser looking for their self-paid orders,
scans the column by eye.

The page already holds every PO in scope client-side (it streams all pages
and computes chip counts, KPIs, search and sort over the array), so the new
filters are client-side too: a click re-renders the table instantly with no
refetch and no skeleton — the "smooth" the ask wants.

## Acceptance criteria

- [x] The desktop PO list has a chip row with a Warehouse group (All, one
      chip per warehouse seen in the loaded POs, plus No warehouse when a PO
      has none) and a Payment group (All, Company, Self).
- [x] Each chip carries the count of POs the click would show, given every
      other filter on the page (search, Done toggle, stage, Sold, the other
      group).
- [x] Clicking a chip narrows the table without a refetch; clicking the
      active chip again clears that group.
- [x] The stage chips and KPI counts honour the warehouse / payment picks.
- [x] Both picks survive the open-PO → back round-trip like the other
      filters (`usePersisted`).
- [x] Non-managers (who have no stage rail) get the row too.

## Out of scope

- The phone list — the ask came with a desktop screenshot.
- Server-side `warehouse=` / `payment=` params on `GET /api/orders`: the
  page never pages from the server, so a server filter would buy nothing.
- Multi-select within a group.

## Notes

- Warehouse chips are listed from the loaded POs, not `GET /api/warehouses`,
  so a warehouse with no PO in scope never shows and the list cannot drift
  from the table.
- The facet maths lives in `lib/poFacets.ts` (pure, unit-tested) so the
  component only wires chips to state.
