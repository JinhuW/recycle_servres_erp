---
id: RS-241
title: After-sales cases: track returns and discounts on sold orders
type: story
status: in-progress
priority: P2
created: 2026-10-12
reporter: jinhu
branch: feat/after-sales
pr:
version:
related: []
---

## Ask

> Background:
>
> Some sold product may need to after sell service and it may take some time to process. the client support return or take discounto sell it.
>
> Pls create a new workflow after sell and help me create an page to tracking the after sell case.

## Context

Once a sell order is Shipped, Awaiting payment or Done, nothing in the ERP
records a customer coming back with a problem. The fix takes days or weeks
(the customer tests, we argue condition, the goods come back or a price is
agreed), so it needs its own record with a status rather than a line in the
sell order's notes. The customer has two ways out: send the goods back
(return) or keep them at a reduced price (discount).

Sell orders are manager-only (`routes/sellOrders.ts`), so after-sales is too.
Sell-order lines are rewritten on every editor save (new row ids), so a case
snapshots the lines it is about instead of trusting the line id to live.

## Acceptance criteria

- [ ] A manager can open an after-sales case (`AS-1001`, …) against a sell
      order that is Shipped, Awaiting payment or Done; Draft and Closed orders
      are refused.
- [ ] A case records the issue, the affected lines and quantities (each no
      more than the line's qty), the resolution (Return or Discount), the
      refund / discount amount in the order's currency, and an assignee.
- [ ] The workflow is Open → In progress → (Awaiting return, for a return) →
      Resolved, with Cancelled from any open stage and Reopen from Resolved
      or Cancelled. Illegal moves are a 409. Resolved needs a resolution and
      an amount; Awaiting return needs resolution = Return.
- [ ] Every status move, field change and note lands on the case's timeline
      with who and when.
- [ ] A new desktop page, **After-sales** (`#/after-sales`), lists the cases
      with status tiles (count of open, in progress, awaiting return,
      resolved, cancelled), a status filter and a search over case id, sell
      order id, customer and issue; a row opens the case page
      (`#/after-sales/AS-1001`).
- [ ] A sell order's page has an **After-sales** button (Shipped / Awaiting
      payment / Done) that opens the new-case form for that order, and lists
      the order's existing cases.
- [ ] Purchasers can't reach the page or the API.

## Out of scope

- Putting returned goods back into stock. A return is tracked to "received"
  and resolved here; restocking still goes through a PO/inventory edit. Doing
  it automatically means unpicking a Done sale's stock movements, which is its
  own piece of work.
- Changing the sell order's revenue or the dashboard's realized profit by the
  discount or refund. The amount is recorded on the case and summed on the
  page, nothing more.
- The phone shell.
- Attachments / photos on a case.

## Notes

- The case keeps a `sell_order_line_id` (nullable, `ON DELETE SET NULL`) next
  to its snapshot of label / part # / unit price, so the link survives while
  the line does and the record survives when it doesn't.
