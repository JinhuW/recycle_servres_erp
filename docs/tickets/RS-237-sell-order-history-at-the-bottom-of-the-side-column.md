---
id: RS-237
title: Sell order History at the bottom of the side column
type: story
status: done
priority: P2
created: 2026-10-12
reporter: jinhu
branch: fix/so-history-side
pr: 621
version: 1.248.2
related: [RS-235, RS-236]
---

## Ask

> Let we move the history to the side buttom.

## Context

Since v1.248.1 the sell order page's History card (folded by default since
v1.248.0) was the last card of the left column, after every product line.
The right-hand column (`so-page-side`) holds the summary, sign-off, payment
receiver, evidence and internal notes.

## Acceptance criteria

- [x] History is the last card in the sell order page's right-hand column.
- [x] It still starts folded.

## Out of scope

- The history entries' own wording (an edited line names its row id).

## Notes

Checked at 1440px on an order with events: the entry grid
(icon · text · time) fits the side column's width.
