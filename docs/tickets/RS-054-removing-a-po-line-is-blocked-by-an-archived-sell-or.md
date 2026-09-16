---
id: RS-054
title: Removing a PO line is blocked by an archived sell order
type: bug
status: done
priority: P2
created: 2026-09-15
reporter: jinhu
branch: fix/remove-line-archived-sell-order
pr: 334
version: 1.144.1
related: []
---

## Ask

> It should not check against an archived sell order.

(With a screenshot of the desktop error dialog: "Something went wrong — A
line you tried to remove is referenced by a sell-order and cannot be
deleted".)

## Context

`PATCH /api/orders/:id` with `removeLineIds` has no sell-order check of its
own. It runs `DELETE FROM order_lines` and the 409 is the catch block
translating a raw foreign-key violation: `sell_order_lines.inventory_id
REFERENCES order_lines(id)` (migration 0002) carries no `ON DELETE` rule, and
0041 never touched it. Postgres cannot see `sell_orders.archived_at`, so every
sell order that ever named the line blocks its removal — Draft, Shipped, Done,
Closed, archived or not.

The fix moves the decision into the route: a sell order holds the line only
while it is not archived. The FK becomes `ON DELETE SET NULL` so an archived
sell order keeps its line as the denormalised snapshot it already carries
(category, label, part number, qty, unit price) and just loses the link.
Every reader of `inventory_id` already tolerates NULL (it has been nullable
since 0002; vendor-bid lines are created that way).

## Acceptance criteria

- [x] Removing a PO line named only by archived sell orders succeeds (200);
      the archived sell order's line survives with `inventory_id` NULL and
      its snapshot intact.
- [x] A non-archived sell order (any status) still blocks with 409, and the
      response carries `offendingLineIds` + `sellOrderIds` like the other
      committed-line 409s, with the sell order named in the message.
- [x] The realistic case works: sell order Done (line flipped to Sold), then
      archived, then the Sold line removed → 200.
- [x] Backend test covers all three outcomes.

## Out of scope

- Exempting Done or Closed sell orders that are not archived. The PO-archive
  dialog and stage revert use a status-based rule (`openSellStatuses()`);
  this guard is archived-only, as asked, and a non-archived Closed sell order
  keeps blocking exactly as before.
- Preserving cost basis for the dashboards after the source line is gone.
  The revenue/profit/commission totals inner-join `order_lines` for unit
  cost, so an archived Done sale whose source line is removed drops out of
  them (the weekly series LEFT JOINs and keeps revenue but loses profit).
  Removing the line is the manager's choice.
- `vendor_bid_lines.inventory_id` has the same NO ACTION FK and still blocks;
  the fallback message now says so instead of blaming a sell order.

## Notes

- An archived sell order is hidden, not frozen: it can still move
  Shipped→Done. With its source line removed it consumes no stock on the way,
  the same as a manual (never-linked) line does today.
