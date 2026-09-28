---
id: RS-113
title: Set each purchaser's home warehouse to the closest warehouse
type: task
status: done
priority: P2
created: 2026-09-26
reporter: Jinhu
branch: feat/purchaser-home-warehouses
pr: "#411"
version: 1.178.1
related: []
---

## Ask

> update the city for each purchaser.
>
> 1. Framingham, MA Jinhu
> 2. Denver, CO Tim
> 3. Phoenix, AZ Kk
> 4. Londonderry, NH Tao
> 5. Watertown, MA Harrison
> 6. Chicago， IL Chris
> 7. Minneapolis, MN stefen
> 8. Erfurt, Thüringen Sternenregen
> 9. Ilmenau, Yanni
>
> kk is cynthia.
> Sternenregen is yuxing
>
> based on this, set up default warehouse.

> choose the closer warehouse.

## Context

Users carry no city. What matters is the home warehouse
(`users.default_warehouse_id`), because a new PO filed without a warehouse
defaults to it. No new warehouses: each purchaser gets the closest of the
existing ones, WH-BOSTON (ships from Framingham), WH-DEN (Broomfield) and WH-ERF
(Erfurt).

## Acceptance criteria

- [ ] Prod (lands with the next dev→main release): Tim, Cynthia and Stefen → WH-DEN; Harrison and Chris → WH-BOSTON.
- [x] Jinhu (WH-BOSTON) and Yuxing (WH-ERF) are already correct and are left untouched.
- [x] A home warehouse someone has already chosen is never overwritten.

## Out of scope

Tao and Yanni have no accounts yet. Once they exist, set their home warehouses
from their profiles: Boston and Erfurt respectively.

## Notes

Chicago is a close call: about 850 mi to Framingham against 900 mi to
Broomfield, so it went to Boston. Migration `0137_purchaser_home_warehouses.sql`.
