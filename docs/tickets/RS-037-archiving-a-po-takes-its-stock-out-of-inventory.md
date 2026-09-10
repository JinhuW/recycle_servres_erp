---
id: RS-037
title: Archiving a PO takes its stock out of inventory
type: story
status: in-progress
priority: P2
created: 2026-09-10
reporter: jinhu
branch: feat/po-archive-stock
pr:
version:
related: []
---

## Ask

> when an PO archived, But the inventory seem still left in our inventory.

> 1. When user archive an PO, The inventory should also out of stock.
> When the stock already in the sell order, It should also prompt an alerts and ask if i want to delete them.

## Context

Archiving a purchase order (`POST /api/orders/:id/archive`, added in v1.45 by
migration 0045) only sets `orders.archived_at` — a "hide from the default
list" flag. Stock has no table of its own: it is every `order_lines` row at
Done / In Transit / Reviewing, and none of the stock readers (inventory list
and export, sellable picker, vendor catalog and bids, MCP search) look at the
archive flag. So an archived PO's goods stayed in stock and sellable.

Prod at the time of writing: PO-1393 archived with 350 units still in stock,
PO-1390 archived with 132 units and one open sell order, PO-1323 archived
with no lines.

## Acceptance criteria

- [ ] Archiving a PO moves every non-Sold line to a new line status
      `Archived`; the inventory list, products view, export, sellable search,
      vendor catalog and MCP search no longer show them. `?status=Archived`
      lists them, like Sold.
- [ ] Unarchiving restores each line to the status it had before the archive
      (read back from the line's audit trail), so a Done line and a Reviewing
      line on the same PO both come back right.
- [ ] If any of the PO's lines sit on an open sell order (Draft / Shipped /
      Awaiting payment), archive is refused with a 409 that names the sell
      orders, their status and the lines. Both shells show that as a dialog
      and offer "Remove from sell orders and archive"; confirming removes the
      sell-order lines (audited on the sell order as `line_removed` with the
      reason), then archives.
- [ ] Done sell orders are never touched (their lines are already Sold).
      Lines out on a pending transfer order refuse the archive without a
      prompt.
- [ ] An archived PO is frozen: edit, delete, stage advance and inventory
      line edits refuse with "unarchive first", and both edit shells render
      it as locked.
- [ ] POs archived before this change have their non-committed lines
      backfilled to `Archived` by a migration.
- [ ] The archive dialog copy says stock leaves inventory; the activity log
      says how many lines moved.

## Out of scope

- `GET /api/inventory/analysis` has no status predicate (Sold counts there
  too); `Archived` shows up as its own status bucket.
- Auto-closing a sell order that the removal leaves empty — it stays, and
  the dialog names it.
- Pending vendor bids on archived lines: they fail at promote time with the
  existing "not sellable" message, as Sold lines do.
- An "Archived" chip in the inventory status filter (the chips omit Sold as
  well; archived lines are reached through the PO).

## Notes

- Line status, not an `archived_at` filter, because three stock readers
  (`vendorPublic` catalog and bid submit, `vendorBids` availability) never
  join `orders` — the same reason Sold works by status.
- Removal is offered for Shipped and Awaiting-payment sell orders too, as
  asked; the dialog shows each sell order's status. Flagged as a product call.
- PO-1390 keeps its one committed line in stock after the backfill; unarchive
  and re-archive it in the UI to get the prompt.
