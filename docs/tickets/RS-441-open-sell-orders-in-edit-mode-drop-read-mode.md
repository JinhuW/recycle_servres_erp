---
id: RS-441
title: Open sell orders in edit mode, drop read mode
type: story
status: done
priority: P2
created: 2026-10-28
reporter: jinhu
branch: JinhuW/gudgeon-2
pr:
version: 1.375.0
related: []
---

## Ask

> remove the read mode and use the edit mode by default in the sell order by default

> This section will appear when change made.
> (on a screenshot of the sell order page's sticky footer: "No changes · Discard · Cancel · Save changes")

> It shoudl alo have a combined mode. not group by warehouse or po.
> (on a screenshot of the Products card's "By warehouse / By PO" switch)

## Context

The desktop sell order page (`SellOrderDetail` in
`apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`) had two modes:
`/sell-orders/:id` was read-only, and **Edit order** swapped to
`/sell-orders/:id/edit`, the builder with a sticky Save footer that stayed up
even with nothing to save. Every change to an order cost an extra click and a
refetch. Done and Closed orders are locked and stay read-only.

The Products card grouped lines by warehouse or by PO, with no way to see the
order as one flat list.

## Acceptance criteria

- [x] `/sell-orders/:id` opens an unlocked order in the editor; no **Edit
      order** button, no "Editing" chip.
- [x] `/sell-orders/:id/edit` still opens (old links) and shows the same page.
- [x] The Save/Cancel footer is hidden until something changes; Cancel reverts
      the edits in place.
- [x] Saving stays on the order and reloads it.
- [x] Close-order (red **Discard**) sits in the header actions.
- [x] Pack, After-sales, Payments ledger, Accounting card and After-sales
      cases show on the editable page as they did in view mode.
- [x] Sign / Withdraw sign-off work with no unsaved changes; hidden while
      there are some (a sign-off approves the saved order).
- [x] Done / Closed orders look and behave as their view page did.
- [x] The Products card's switch gains **Combined**: one ungrouped table in
      line # order, with a Warehouse column and the PO under each item;
      remembered like the other two, default stays By warehouse.

## Out of scope

Mobile (it has no sell-order page); the Pack page.

## Notes

Plan: `~/.claude/plans/frolicking-twirling-sparrow.md` (approved 2026-10-28).
