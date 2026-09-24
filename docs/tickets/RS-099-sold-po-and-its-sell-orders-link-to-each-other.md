---
id: RS-099
title: Sold PO and its sell orders link to each other
type: story
status: done
priority: P2
created: 2026-09-24
reporter: jinhu
branch: feat/po-sell-order-links
pr: https://github.com/JinhuW/recycle_servres_erp/pull/395
version: 1.174.0
related: [RS-060, RS-064, RS-085]
---

## Ask

> For sold PO, pls link all sell order to the PO.
>
> I hope both of them can link.

## Context

A Sold PO (v1.164.0) says "Sold out" but not which sell orders sold it, and a
sell order's lines say nothing about the PO they came from. The join already
exists — `sell_order_lines.inventory_id` → `order_lines.order_id` — and the
final-sell-price and Realized figures already read it; nothing surfaced it as
a link.

## Acceptance criteria

- [ ] `GET /api/orders/:id` returns `sellOrders` — the Done sell orders naming
      any of the PO's lines, with customer and qty — for managers; `null` for
      purchasers and a manager previewing as one.
- [ ] Desktop PO page: the Sold panel (and the Done panel when something has
      sold) lists those sell orders as links to `/sell-orders/<id>`.
- [ ] Phone PO page lists the same ids beside the Realized sold count (text:
      the phone has no sell-order page).
- [ ] `GET /api/sell-orders/:id` lines carry `sourceOrderId`; the sell order
      view shows each line's PO as a link to `/purchase-orders/<id>`.

## Out of scope

Committed (not yet Done) sell orders on the PO page; a sell-order page on the
phone.

## Notes

Plan: `~/.claude/plans/immutable-hopping-finch.md`. Done only, matching
finalSellPrice/Realized; an archived Done sell order stays listed (it sold the
units), a reopened one drops out.
