---
id: RS-611
title: Send to eBay from the Inventory list
type: task
status: done
priority: P2
created: 2026-11-23
reporter: jinhu
branch: feat-ebay-send-from-inventory
pr: 1253
version: 1.478.0
related: [RS-609]
---

## Ask

> i didn't see any action can allow me send stock to ebay

## Context

Send to eBay shipped in v1.476.0 only in the header of a lot's edit page, so a
manager working from the Inventory list never sees it.

## Acceptance criteria

- [x] Each sellable lot row in Inventory has Send to eBay in its eBay column.
- [x] A product with one sellable lot has it on the product row too.
- [x] After sending, the list reloads and the lot shows its new eBay chip.
- [x] The eBay desk's empty To post tab tells a manager where to send from.

## Out of scope

A lot picker on the eBay desk itself.
