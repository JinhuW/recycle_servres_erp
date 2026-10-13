---
id: RS-248
title: Sell-order list: quick After-sales button on Done orders
type: task
status: done
priority: P2
created: 2026-10-13
reporter: jinhu
branch: feat/as-list-quick-button
pr: 634
version: 1.256.0
related: [RS-241]
---

## Ask

> pls add a quick button to enter the after sell mode for the Done sell order.

(With a screenshot of the sell-order list filtered to Done, the Actions
column circled: each row shows only the View eye.)

## Context

RS-241 put the After-sales button on the sell order's page. A manager
working from the list filtered to Done has to open each order first to reach
it; a Done order has no Edit button, so its Actions cell is the eye alone.

## Acceptance criteria

- [x] On the sell-order list, a Shipped, Awaiting payment or Done row has an
      After-sales icon button in Actions, after View (and Edit where shown).
- [x] Clicking it opens `#/after-sales/new?order=SO-…` with that order
      preselected, without opening the order page first.
- [x] Draft, Packing and Closed rows show no such button (a case can't be
      opened on them, the form would refuse).
- [x] The tooltip is translated (EN / ZH).

## Out of scope

Opening the existing cases of the order from the list; a count badge. The
order page's After-sales card already lists them.
