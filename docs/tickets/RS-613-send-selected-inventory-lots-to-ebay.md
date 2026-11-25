---
id: RS-613
title: Send selected Inventory lots to eBay
type: task
status: done
priority: P2
created: 2026-11-24
reporter: jinhu
branch: feat-ebay-bulk-send
pr:
version: 1.480.0
related: [RS-609, RS-611]
---

## Ask

> so how can i move the inventory for ebay?
> cuz ebay is type of new inventory
> I hope i can select the item in the current inventory to ebay

## Context

Send to eBay works one lot at a time. Managers pick stock by ticking lots in
Inventory, the same way they start a sell order or a transfer.

## Acceptance criteria

- [x] With lots ticked, the Inventory selection bar has Send to eBay.
- [x] Its dialog lists each lot with its free units, spec, units and price; 0 units skips a lot.
- [x] Each sent lot becomes one To post listing; sent lots leave the selection.
- [x] A lot that fails stays in the dialog with the reason; the others still go.

## Out of scope

A separate "eBay" warehouse: listings still hold units in place.
