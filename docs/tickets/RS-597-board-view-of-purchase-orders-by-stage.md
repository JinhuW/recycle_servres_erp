---
id: RS-597
title: Board view of purchase orders by stage
type: story
status: done
priority: P2
created: 2026-11-16
reporter: jinhu
branch: feat/po-board
pr: #1227
version: 1.469.0
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

- [x] The purchase orders page has a List / Board switch, remembered per user.
- [x] Board columns are the five stages; Done shows only with Show Done on;
      the list's filters apply to the board.
- [x] A card shows PO number, purchaser, supplier, cost, lines, tracking,
      days in stage (Home's tints) and open action count.
- [x] Dropping one stage forward: Draft → In Transit opens the hand-off form;
      In Transit → Reviewing advances (with the manager takeover question);
      Reviewing → Ready to Pay opens the box check; Ready to Pay → Done runs
      the commission-evidence step. Purchasers can drag only their own Draft.
- [x] Backward and multi-stage drops are refused with a hint to open the PO.
- [x] A stale stage or changed manager shows a warning and reloads.

## Out of scope

- A PO board on the phone.
- Manual ordering of POs inside a column.

## Notes

- Ships after the RS-596 drag helper (`lib/boardDrag.ts`).
- The hand-off and Done drops open the PO page with `?step=handoff` /
  `?step=done` and run the page's own `advanceTo`, rather than copying that
  page's checks (unsaved edits, $0 lines, commission evidence) onto the board.
- The Done column is always a drop target; its cards show only with Show Done,
  as the list prunes them.
