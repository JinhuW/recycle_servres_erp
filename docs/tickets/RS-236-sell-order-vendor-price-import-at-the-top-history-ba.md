---
id: RS-236
title: Sell order: vendor price import at the top, History back at the bottom
type: bug
status: done
priority: P2
created: 2026-10-12
reporter: jinhu
branch: fix/so-price-import-top
pr: 620
version: 1.248.1
related: [RS-235]
---

## Ask

> The history should still be in the bottom. I meant this part:
> [Image #1]

(The image shows the edit-mode block "Add inventory", the edit hint, and
**Vendor price import** — the bid-sheet steps and the upload drop zone.)

## Context

RS-235 read "this section" in its ask as History and moved History to the top
in v1.248.0. The section meant was `PriceImportSection`
(`SellOrderPriceImportDialog.tsx`), rendered in edit mode after the products
and the Add inventory button — on a long order, a scroll past every line.

## Acceptance criteria

- [x] In edit mode, Vendor price import is the first block in the order card.
- [x] History is back as the last card in the left column, still folded.

## Out of scope

- Moving Add inventory or the edit hint; the ask names the import block.

## Notes

The import section's own `marginTop: 18` went with it — first in the card it
only added a gap above.
