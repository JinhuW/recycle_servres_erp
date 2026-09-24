---
id: RS-100
title: Add inventory selection to an existing sell order
type: story
status: done
priority: P2
created: 2026-09-24
reporter: jinhu
branch: feat/add-to-existing-sell-order
pr: "#397"
version: 1.175.0
related: []
---

## Ask

> help me create an feature that it can also add to exitsing sell orders.
>
> (screenshot: the desktop Inventory selection bar — "7 lines · 28 units · $0
> est. revenue · Unselect all · Clear · Transfer · Create sell order")

## Context

The Inventory selection bar could only start a *new* sell order. Topping up an
order that already exists meant opening it, clicking Add inventory and
re-finding the same lots in the picker. The sell-order edit modal already knows
how to append lots and save them (PATCH with the full line set, re-validated
server-side), so the selection is routed into that path.

## Acceptance criteria

- [ ] With lots selected on desktop Inventory, the selection bar (and toolbar)
      offers "Add to sell order" next to Transfer / Create sell order (managers).
- [ ] It opens a picker of open sell orders — Draft / Shipped / Awaiting
      payment, not archived — searchable by order id or customer.
- [ ] Picking one opens that order's edit modal over Inventory with the
      selected lots appended; lots already on the order are not duplicated,
      and a notice says so when every selected lot is already there.
- [ ] Saving writes the lines (history shows `line_added`), closes the modal,
      clears the selection, refreshes inventory and toasts the order id.
      Cancelling changes nothing and keeps the selection.
- [ ] Archive / Close / Unarchive are not offered in that modal.

## Out of scope

- Phone inventory (it has no sell-order selection bar).
- Netting the added qty against units other orders already committed — the
  server refuses an over-commit with a clear message, same as Create sell order.
- Backend changes.

## Notes

- New lines take the unit price the order already has for that product, else 0
  (the existing Add-inventory rule), not the `sellPrice × 1.35` seed of Create
  sell order — the order may be quoted in CNY.
- Plan: `~/.claude/plans/enchanted-dreaming-eich.md`.
