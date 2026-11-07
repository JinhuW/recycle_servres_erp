---
id: RS-568
title: Allow a unit cost of 0 on a PO line
type: task
status: done
priority: P2
created: 2026-11-07
reporter: jinhu
branch: JinhuW/cownose
pr: 1163
version: 1.444.2
related: []
---

## Ask

> enable unit cost is 0
> enable unit cost is 0 in the po

(With a screenshot of the PO edit page's line drawer: Qty 2, Unit cost 0,
the table row showing "—" for unit cost.)

## Context

The phone form has accepted a typed $0 since v1.426.0, but the desktop PO edit
page still ran the line rule with `cost > 0`, so a product typed at $0 counted
as missing Unit cost and blocked Confirm line and Save. The backend has always
accepted `unit_cost >= 0`, and the leave-Draft check already asks about $0
products.

## Acceptance criteria

- [x] On the desktop PO edit page, a line with Unit cost 0 confirms and saves.
- [x] A blank Unit cost on a new or touched line is still refused.
- [x] The table shows $0.00 for a typed 0 instead of "—".

## Out of scope

The desktop Submit Order page and the RAM sheet scan still require cost > 0. A
saved $0 line still reopens with a blank cost, since the database stores an
unpriced line as 0 too.
