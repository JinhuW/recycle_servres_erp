---
id: RS-082
title: Payment tab is two columns
type: task
status: in-progress
priority: P3
created: 2026-09-20
reporter: jinhu
branch: feat/rs-082-payment-columns
pr:
version:
related: [RS-080]
---

## Ask

> 使用左右结构
> [screenshot: the desktop Payment tab — Paid by / Method above a full-width
> chat-screenshot proof panel]

## Context

The Payment tab (RS-080, v1.160.0) renders the shared `PaymentFields` as it
renders everywhere: *Paid by* and *Method* on one row, the proof panel at
full width beneath. On a wide page that leaves the short proof list stretched
across the whole tab. The tab is the one place with room for two columns;
the phone, the checkpoint dialog and the create page keep one.

## Acceptance criteria

- [x] On the desktop Payment tab, *Paid by* and *Method* stack on the left
      and the proof panel sits on the right, for all three payment paths.
- [x] Under 1100px the tab goes back to one column; other surfaces of
      `PaymentFields` are unchanged.

## Out of scope

—

## Notes

- CSS only: `.oe-pay` on the tab wrapper, rules beside `.pay-fields` in `desktop.css`.
