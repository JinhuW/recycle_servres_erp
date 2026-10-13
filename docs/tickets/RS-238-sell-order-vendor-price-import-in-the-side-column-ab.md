---
id: RS-238
title: Sell order vendor price import in the side column, above the summary
type: story
status: done
priority: P2
created: 2026-10-12
reporter: jinhu
branch: fix/so-price-import-side
pr: 622
version: 1.248.3
related: [RS-236, RS-237]
---

## Ask

> let we also move the Vendor price import to the side, on up side of the order summary

## Context

v1.248.1 (RS-236) put `PriceImportSection` first in the sell order page's
left card in edit mode. History moved to the right-hand column in v1.248.2
(RS-237); this puts the import there too, above Order summary.

## Acceptance criteria

- [x] In edit mode, Vendor price import is its own card at the top of the
      right-hand column, above Order summary.
- [x] It no longer renders in the left card.
- [x] In the side column's width the drop zone stacks under the steps.

## Out of scope

- —
