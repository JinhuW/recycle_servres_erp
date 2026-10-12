---
id: RS-235
title: Move sell-order History to the top, folded by default
type: story
status: done
priority: P2
created: 2026-10-12
reporter: jinhu
branch: fix/so-history-top
pr: 619
version: 1.248.0
related: []
---

## Ask

> 1.move this section to top of the sell order management section. cuz it too bother to scroll to the buttom. 
> 2. History fold by default.

> also enable some quick search which is similiar with the Pack mode.

## Context

The sell order page (`DesktopSellOrders.tsx`, full page since v1.194.0)
rendered its History card after the products card, opened (`<details open>`).
On an order with many lines it was a long scroll away. Pack mode
(`DesktopSellOrderPack.tsx`) already filters its list from a scan box through
`useScanFilterText` and `packFilter`; the order page had no way to find a line.

## Acceptance criteria

- [x] History is the first card in the sell order page's left column.
- [x] History starts folded; clicking its heading opens it.
- [x] A search box over the products filters the listed lines in view and
      edit mode, by part #, serial or PO number (separators ignored) and by
      words in the item name / spec chips.
- [x] `/` focuses the box; Esc clears it, then blurs it, never leaving the page.
- [x] The line summary, order total and Save are unaffected by the filter.

## Out of scope

- Enter-to-act (Pack mode packs a scanned lot); the order page has nothing to
  tick, so Enter does nothing.
- The mobile shell's sell order view.
- Remembering the fold state across visits.

## Notes

Matching lives in `filterLineGroups` (`lib/sellOrderLineGroups.ts`) with tests
beside it; it filters the already-grouped cards so edit rows keep their flat
index into `draft.lines`.
