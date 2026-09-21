---
id: RS-093
title: Realized profit has its own column toggle on the desktop PO list
type: story
status: done
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/rs-092-realized-column-toggle
pr: https://github.com/JinhuW/recycle_servres_erp/pull/386
version: 1.171.0
related: [RS-064]
---

## Ask

> Add realized profit field to the table in the PO page which is manager only.

(with a screenshot of the desktop PO list showing Order ID, Date, Submitter,
Category, Warehouse, Products, Qty, Payment, Status and Actions — Cost,
Revenue, Profit and Commission switched off)

## Context

The manager-only Realized column has been on the desktop PO list since
v1.149.0 (RS-064), but it rode on the **Profit** toggle: hide Profit and
Realized went with it, and the Columns picker had no entry to bring it back
alone. The screenshot is exactly that state — a manager's compact column set
with no way to add the one figure they wanted. The backend already returns
`realized` on the list for managers; nothing was missing but the toggle.

## Acceptance criteria

- [ ] The Columns picker on the desktop PO list offers **Realized profit** to
      managers, on by default. Purchasers, and a manager previewing as
      purchaser, don't see the entry.
- [ ] The Realized column shows and hides on that toggle alone; the Profit
      toggle no longer affects it. Sorting by the Realized header still works.
- [ ] The picker's count badge and its **All** button count only the columns
      the current role can see.

## Out of scope

- Making Realized always-on for managers. It stays hideable like every other
  money column.
- Migrating stored column preferences: a manager who customised Columns before
  this release ticks Realized profit once.

## Notes

Plan: `~/.claude/plans/wise-gathering-dijkstra.md`. Frontend-only change in
`apps/frontend/src/pages/desktop/DesktopOrders.tsx`.
