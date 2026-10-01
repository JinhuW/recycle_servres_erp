---
id: RS-126
title: Packing list grouped by PO
type: story
status: done
priority: P2
created: 2026-09-30
reporter: jinhu
branch: feat/so-package-list-by-po
pr: "#431"
version: 1.189.0
related: []
---

## Ask

> The current sell order has a package spreadsheet. It is based on the warehouse for now.
>
> let we also create on package list groupby the PO number and it can still be selected by warehouse.

Follow-up, on the plan:

> also for each po subpage, it should also follow the same pattern as the main page. group by the generation, desktop/servers ect.

## Context

The sell order's Packing list download has one `Pack - <warehouse>` tab per
warehouse. Stock arrives on purchase orders, so a picker working PO by PO wants
the same checklist cut by PO instead.

## Acceptance criteria

- [x] The desktop sell order view offers "Packing list by PO" beside "Packing list".
- [x] That workbook has one tab per PO per warehouse (`PO-1442 - DEN`), POs in
      numeric order, lines without a PO on a `No PO - <warehouse>` tab.
- [x] Each PO tab reads like a warehouse pack tab: category sections, RAM grouped
      by Desktop & laptop / Server and DDR generation, tick boxes, quantities,
      subtotals, no prices.
- [x] A warehouse picker (All warehouses by default) narrows both packing lists
      to one warehouse; an unknown warehouse is a 400.
- [x] The existing packing list is unchanged when no warehouse is picked.

## Out of scope

- The vendor bid sheet — the warehouse picker does not touch it.
- The phone shell, which has no sell-order downloads.

## Notes

Plan: `~/.claude/plans/dapper-snuggling-origami.md`. Same route with query
params (`?groupBy=po&warehouse=<short>`), not a new endpoint.
