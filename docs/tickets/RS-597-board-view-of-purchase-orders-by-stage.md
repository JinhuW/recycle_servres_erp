---
id: RS-597
title: Board view of purchase orders by stage
type: story
status: backlog
priority: P2
created: 2026-11-16
reporter: jinhu
branch:
pr:
version:
related: [RS-596]
---

## Ask

> pls also create a dedicated view for the PO pages.

## Context

Asked while planning RS-596. Offered four readings; the owner picked "Board
of the POs themselves": a kanban of purchase orders by stage as another way
to look at the PO list, toggled List / Board. For dragging, the owner chose
"drag runs the normal step": dropping a card one stage forward starts the
same step the PO page uses, and nothing skips a check.

Today the desktop list (`pages/desktop/DesktopOrders.tsx`) loads every PO in
scope through `forEachKeysetPage` and filters client-side; stage moves go
through `advanceOrderTx` (`services/orderAdvance.ts`), with the hand-off form
for Draft → In Transit, the box check before Ready to Pay and optional
commission evidence before Done.

## Acceptance criteria

- [ ] The purchase orders page has a List / Board switch, remembered per user.
- [ ] Board columns are the five stages; Done shows only with Show Done on;
      the list's filters apply to the board.
- [ ] A card shows PO number, purchaser, supplier, cost, lines, tracking,
      days in stage (Home's tints) and open action count.
- [ ] Dropping one stage forward: Draft → In Transit opens the hand-off form;
      In Transit → Reviewing advances (with the manager takeover question);
      Reviewing → Ready to Pay opens the box check; Ready to Pay → Done runs
      the commission-evidence step. Purchasers can drag only their own Draft.
- [ ] Backward and multi-stage drops are refused with a hint to open the PO.
- [ ] A stale stage or changed manager shows a warning and reloads.

## Out of scope

- A PO board on the phone.
- Manual ordering of POs inside a column.

## Notes

- Ships after the RS-596 drag helper (`lib/boardDrag.ts`).
