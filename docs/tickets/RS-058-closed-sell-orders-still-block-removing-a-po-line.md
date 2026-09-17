---
id: RS-058
title: Closed sell orders still block removing a PO line
type: bug
status: in-progress
priority: P2
created: 2026-09-17
reporter: jinhu
branch: fix/remove-line-closed-sell-order
pr:
version:
related: [RS-054]
---

## Ask

> i can see this dialog, But these sell order already archived.

(With a screenshot of the desktop error dialog: "Something went wrong — A
line you tried to remove is on sell orders SO-4047, SO-4048, SO-4057 and
cannot be deleted. Archive or cancel those sell orders first.") Then, on the
finding that the three were Closed rather than archived:

> so also inlcude closed + archived sell order.

> take the recommended fix

## Context

In prod, SO-4047, SO-4048 and SO-4057 are status Closed (closed 2026-09-10,
09-13 and 09-16) and none has `archived_at` set — nothing but the Archive
action on the sell-order list sets it. The v1.144.1 guard (RS-054) refuses
while any non-archived sell order names the line, whatever its status, and
that ticket deferred Closed on purpose.

That rule is the only sell-order guard in the codebase that ignores status.
`lib/sellCommitment.ts` defines `OPEN_SELL_STATUSES` (Draft, Shipped,
Awaiting payment) as "every status in which a sell order still names its
lines": Closed released the stock, Done consumed it. The PO archive dialog
and stage revert (`services/orderAdvance.ts`) already use that set. So
closing a sell order unblocked archiving the PO but not removing one of its
lines, and the dialog's own advice — "Archive or cancel those sell orders
first" — was half false: cancelling did nothing.

The recommended fix, taken: refuse only while a sell order is not archived
**and** in `openSellStatuses()`. Closed, Done and archived sell orders all
keep their line as the snapshot it already carries (FK is SET NULL since
0127) and let the source line go. Done releasing without an archive is the
one behavioural widening beyond the literal ask; it matches the archive
dialog, whose claim query skips Sold lines outright, and dashboards never
read `archived_at`, so it costs nothing RS-054 had not already accepted.

## Acceptance criteria

- [x] Removing a PO line named only by Closed sell orders succeeds (200);
      each Closed sell order's line survives with `inventory_id` NULL and
      its snapshot intact.
- [x] A Done sell order releases its Sold line the same way, without being
      archived first.
- [x] Draft, Shipped and Awaiting-payment sell orders that are not archived
      still block with 409, naming the sell orders and lines.
- [x] Archived sell orders keep releasing the line (RS-054 behaviour).
- [x] Backend test covers Closed, Done, Draft, Shipped and archived.

## Out of scope

- The PO delete guard (`routes/orders.ts`, "sold" refusal) and the
  inventory `NOT EXISTS` check, both of which are status- and archive-blind.
  Not asked for.
- `vendor_bid_lines.inventory_id` keeps its NO ACTION foreign key.
- Preserving dashboard cost basis after a Sold source line is removed
  (unchanged from RS-054).

## Notes

- Reverses RS-054's "Out of scope: exempting Done or Closed sell orders
  that are not archived".
- The 409 message is unchanged; "Archive or cancel" is now true as written.
- No migration.
