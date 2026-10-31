---
id: RS-484
title: Phone Market card shows the full SKU spec
type: bug
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: JinhuW/whelk
pr: 1031
version: 1.395.1
related: []
---

## Ask

> fix this mobile issue. It only show part of the ram spec.

(Attached: an iPhone screenshot of Market → RAM, with cards reading
"Samsung 32GB Server RDIMM 2…", "Micron 16GB Laptop SODIMM 1R…".)

## Context

The phone Market page (`apps/frontend/src/pages/Market.tsx`) clipped each
card's SKU label to one line with an ellipsis, and the sell-price column next
to it does not shrink. On a phone a RAM label lost its rank, speed and part
number, which are what a buyer needs to match a listing.

## Acceptance criteria

- [x] On a 390px-wide phone, a long RAM label wraps to as many lines as it needs and shows in full
- [x] The sell-price column stays right-aligned and keeps its width
- [x] A long unbroken part number wraps instead of overflowing the card

## Out of scope

The desktop Market table, and the card's sub line, which keeps its one-line ellipsis.
