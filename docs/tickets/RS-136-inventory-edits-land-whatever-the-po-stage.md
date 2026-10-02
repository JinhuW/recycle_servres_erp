---
id: RS-136
title: Inventory edits land whatever the PO stage
type: bug
status: done
priority: P2
created: 2026-10-01
reporter: jinhu
branch: fix/rs136-inventory-edit-any-stage
pr: "#448"
version: 1.192.1
related: [RS-131]
---

## Ask

> In the inventory, The edit should still take effect no matter the PO status.

Answer to the scoping question (should qty & unit cost also be editable on a
Ready to Pay / Done / Sold PO?):

> All fields except qty & cost

## Context

The desktop inventory editor (`DesktopInventoryEdit.tsx`) PATCHed every field
on every save, changed or not. `PATCH /api/inventory/:id` reads a present key
as an edit. On a Ready to Pay / Done / Sold PO the unchanged `qty` and
`unitCost` therefore tripped the closed-book 409 ("past review; move it back
to Reviewing"), and nothing saved. In prod this hit PO-1435 (Done) with three
409s on 2026-10-01.

The route had always meant sell price, status and specs to stay editable
after Done (see the `doneLocked` comment in `routes/inventory.ts`); the editor
never let them through. The same over-send made an unchanged `status` trip the
open-sell-order 409, so a spec-only edit on a committed line failed too.

## Acceptance criteria

- [x] The editor sends only the fields that changed.
- [x] On a Ready to Pay / Done / Sold PO, sell price, status, condition, part #,
      health, RPM and spec edits save.
- [x] Qty and unit cost are disabled on those POs, with a hint linking the PO.
- [x] Qty and unit cost still save on Draft → Reviewing POs.
- [x] Backend test: a manager's non-goods PATCH on a Done PO → 200;
      `GET /api/inventory/:id` exposes `order_closed_book`.

## Out of scope

- Qty / unit cost from Ready to Pay on. They stay frozen because they feed
  the goods total and the commission basis.
- Walking a line off Sold on a fully sold PO. That undoes a sale; reopen the PO
  to Ready to Pay instead.
- Archived POs stay read-only. Archive is a flag, not a stage.
- Clearing part # or condition to blank. The route COALESCEs both, unchanged
  from before.

## Notes

Plan: `~/.claude/plans/functional-wondering-hoare.md`. A backend-only fix
("ignore keys equal to the current row") was rejected. It needs per-field
normalisation, and it would hide the client bug.
