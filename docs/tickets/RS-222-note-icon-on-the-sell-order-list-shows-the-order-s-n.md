---
id: RS-222
title: Note icon on the sell-order list shows the order's note on hover
type: story
status: done
priority: P2
created: 2026-10-10
reporter: jinhu
branch: feat/so-list-note-hint
pr: 588
version: 1.239.0
related: []
---

## Ask

> cerate an note icon here.
>
> [Image #1]
>
> when user hover to the note icon. It will show the note we create in the sell order.

(Image #1: the desktop Sell orders list, with a red box drawn just right of
the customer name on the SO-4059 row.)

## Context

The desktop Sell orders list (`#/sell-orders`, `DesktopSellOrders.tsx`) gave
no sign that an order carried internal notes — the only way to find out was to
open each order. `GET /api/sell-orders` already returned `notes` on every row,
so this is a frontend-only change. Sell orders are manager-only, so the note
needs no further gating. There is no phone sell-order list.

## Acceptance criteria

- [x] A row whose internal note is non-empty (after trimming) shows a note icon
      right after the customer name; a row without one shows nothing.
- [x] Hovering the icon shows a card with the note, line breaks kept; a very
      long note is clamped at 14 lines.
- [x] Moving down the column goes straight from one icon's card to the next —
      the card takes no pointer, so it never blocks the icon under it.
- [x] Keyboard focus (Tab) opens it; Escape and blur close it.
- [x] The card is not clipped on the last row of the table (it flips above when
      there is no room below), and follows its row when the page scrolls.
- [x] Clicking the icon does not open the order; clicking the rest of the row
      still does.
- [x] An archived row's card is shown at full opacity, not the row's dimmed one.

## Out of scope

- Searching the list by note text — not asked.
- A separate touch interaction: a tap on a tablet opens the card through the
  browser's emulated hover, which is enough for a manager page.
- Native `title=` tooltip — rejected: ~1s delay, tiny font, no keyboard access.
- Selecting text inside the card. The approved plan let the mouse move into
  the card; in the browser the card, hanging below its row, then covered the
  next row's icon and blocked running down the column. Reading a run of notes
  matters more than copying from the hint, and the order page already shows
  the note as selectable text.

## Notes

- Plan: `~/.claude/plans/fizzy-coalescing-otter.md`.
- The card is `position: fixed` and portalled to `document.body`, placed by
  `useFixedPopover` (`pages/desktop/popoverPlacement.ts`): fixed because
  `.table-scroll` clips anything absolute at the table's bottom edge;
  portalled because archived rows carry `opacity: 0.55` on the `<tr>`.
