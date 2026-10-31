---
id: RS-485
title: Phone Market card shows part number and last updated time
type: story
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: JinhuW/whelk-rs485
pr: 1033
version: 1.395.2
related: [RS-484]
---

## Ask

> it should also show the part number

> it should not only show the part number, But also last updated time.

(Both follow RS-484, which made the phone Market card show the whole SKU name.)

## Context

`GET /api/market` already returns `partNumber` and `updatedAt` for every SKU,
and the desktop Market table shows both. The phone card
(`apps/frontend/src/pages/Market.tsx`) showed neither: the updated time was
only in the tap-to-expand panel, and the part number was nowhere on the phone.

## Acceptance criteria

- [x] Each phone Market card shows its part number under the name, in mono, without tapping
- [x] Each card shows "Updated 3d ago" (from `updatedAt`, the same time the expanded panel uses) without tapping
- [x] A SKU with no part number shows only the updated time
- [x] A long part number wraps instead of overflowing the card

## Out of scope

The desktop table, which already shows both, and the backend.
