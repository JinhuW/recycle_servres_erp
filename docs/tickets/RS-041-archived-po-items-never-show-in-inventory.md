---
id: RS-041
title: Archived PO items never show in inventory
type: bug
status: in-progress
priority: P1
created: 2026-09-12
reporter: jinhu
branch: fix/archived-po-inventory
pr:
version:
related: [RS-037, RS-038]
---

## Ask

> debug the reason that i already shipped a feature that sell order will not inlcude any archived order.

> make sure all archived PO item, do not show in the inventory

## Context

v1.137.0 (RS-037) made archiving a PO move its non-Sold lines to the
`Archived` line status, and every stock reader keys on line status. Two gaps
left archived goods in stock anyway:

1. **Data.** Migration `0121` backfilled POs archived before that release but
   deliberately skipped any line sitting on an open sell order. Prod PO-1390
   (archived 2026-09-01) still held all five lines at `Reviewing`, all on Draft
   SO-4048 — created 2026-09-10, one day before 0121 ran. Because the lines
   were `Reviewing`, `/api/sell-orders/sellable` kept offering them and the
   inventory list kept showing them. Jinhu cleared this one by hand
   (unarchive + re-archive, 2026-09-12 01:46 EDT, which removed the five lines
   from SO-4048), so migration `0124` is a verified no-op in prod; it closes
   the same gap for any other environment and for any pre-cascade state that
   surfaces later.
2. **Code.** No inventory-facing `order_lines` read checked `orders.archived_at`.
   Protection was entirely line-status based, and `0122` itself proves status
   alone is incomplete: it legitimately puts an archived PO's transfer-stranded
   line back at `In Transit`.

Rule adopted: a line of an archived PO is hidden from stock unless it is
`Sold` (the sales record, still under the "Show sold" / `?status=Sold` rules)
or `Archived` (still reachable via `?status=Archived`).

## Acceptance criteria

- [x] A non-Sold line whose PO is archived never appears in the inventory
      list, products view, export, Analysis, sellable picker, MCP sellable
      search or vendor catalog, whatever its line status
      (`?status=Archived` excepted).
- [x] It cannot be added to a sell order, bid on, accepted, or transferred.
- [x] Migration 0124 archives every remaining line of pre-release archived
      POs and pulls them off open sell orders with the same audit trail the
      Archive button writes; idempotent; Sold and pending-transfer lines
      untouched.
- [x] Prod: PO-1390's five lines are `Archived` and no archived PO holds a
      line at a stock status (verified read-only 2026-09-12 before the PR).

## Out of scope

Dashboards, market averages, the activity feeds, item-type usage counts,
transfer-order listings, `/api/inventory/events/by-part`,
`GET /api/inventory/:id` and `/:id/sell-orders` (per-line drill-downs reached
by direct link), the `?ids=` export bypass, and PO detail, which must keep
showing its own lines. Deleting the emptied sell order after removal — the
runtime leaves it in place too.

## Notes

- Migration `0124` deviates from the Archive button in one place: the button
  refuses the whole archive when a line is on a pending transfer; the backfill
  skips just that line (as 0121 + 0122 settled it) so the rest of the PO still
  leaves stock.
- Plan: `~/.claude/plans/toasty-crafting-tower.md` (session-local).
