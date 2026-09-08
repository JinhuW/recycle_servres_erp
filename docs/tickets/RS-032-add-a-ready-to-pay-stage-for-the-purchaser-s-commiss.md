---
id: RS-032
title: Add a Ready to Pay stage for the purchaser's commission
type: story
status: in-review
priority: P2
created: 2026-09-07
reporter: Jinhu
branch: feat/ready-to-pay-stage
pr:
version:
related: []
---

## Ask

> Add a new status that is ready to pay the commission fee.

## Context

The PO lifecycle was draft → in_transit → reviewing → done
(`LINE_STATUS_FOR_LIFECYCLE`, `services/orderAdvance.ts`), and Done carried
two meanings at once: the review is finished, and the purchaser's commission
is settled. Nothing in between recorded "reviewed, payment owed".

Decided with Jinhu: a new stage `ready_to_pay` between Reviewing and Done —
review finished, commission payable; Done now means the commission was paid.
The warehouse manager moves a PO into it (the RS-031 gate); any manager
moves it on to Done.

Design choices, recorded because they are not obvious from the code:

- **Lines stay `Done`** while the order is Ready to Pay. Line status is the
  inventory vocabulary — every stock and sellable bucket reads Done as "goods
  confirmed by review" — and a Ready to Pay order is exactly that. A fifth
  line status would have had to thread through every bucket for no gain.
- **The book closes at Ready to Pay**, not Done: the figure is what the
  purchaser gets paid on, so lines, costs, payment reference and ownership
  freeze there; notes stay appendable. The purchaser's edit window ends there.
- **Done keeps the evidence dialog**, which now doubles as the payment proof.
- **Projected commission** on the dashboard counts Ready to Pay and Done POs:
  it becomes owed at Ready to Pay.
- No migration: `orders.lifecycle` is unconstrained text.

## Acceptance criteria

- [x] A manager advance from Reviewing lands on Ready to Pay; lines read
      Done; the next advance reaches Done, then nothing.
- [x] The book closes at Ready to Pay: purchaser edits 403, manager edits to
      lines/fees/owner 409, notes still append; shipments and line goods edits
      refuse as they do for Done.
- [x] Backward moves: Done → Ready to Pay, Ready to Pay → Reviewing, Done →
      Reviewing (existing), manager-only, with the committed-line guard on any
      move that pulls lines off Done.
- [x] Orders lists, filters, steppers, activity log and analysis colours show
      the stage on both shells; "hide Done" keeps Ready to Pay visible.
- [x] Managers and the PO owner get an `order_ready_to_pay` notification on
      forward entry only.
- [x] Dashboard projected commission counts Ready to Pay + Done POs.
- [x] A stage label can never be written as a *line* status (400).

## Out of scope

- Recording the commission payment itself (amount, date, method).
- Reopening from the mobile shell.
- Translating stage labels; the steppers render them raw, as before.
