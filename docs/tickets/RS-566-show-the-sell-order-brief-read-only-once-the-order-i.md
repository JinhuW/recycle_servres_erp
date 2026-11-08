---
id: RS-566
title: Show the sell order brief read-only once the order is done
type: story
status: done
priority: P2
created: 2026-11-07
reporter: jinhu
branch: JinhuW/scallop
pr: 1160
version: 1.444.0
related: []
---

## Ask

> The sell order page, once we finish the SO. it should still show the brief info about the sell order which is same as the edit page.but read onlu

(Sent with a screenshot of SO-4090, Done: the page opened straight on
Products.)

## Context

`DesktopSellOrders.tsx` treats a Done or Closed order as `locked`, and the
Order status stepper and the Customer block (customer, currency, payment
receiver) were both gated on `editable = !locked`. So once an order was
finished the page lost its brief and opened on the product lines.

## Acceptance criteria

- [x] A Done order shows the Order status stepper with every step reached and
      Done active, and no step can be clicked (no status dialog opens).
- [x] A Done or Closed order shows the Customer block in the editor's layout:
      customer name (+ region), currency and payment receiver, as text, not
      inputs.
- [x] A Closed order shows the Customer block; the stepper stays hidden
      (Closed is not a stepper step, and the Closed banner carries it).
- [x] The editor (Draft → Awaiting payment) is unchanged.
- [x] The live payment-receiver picker in the side column of a locked order
      stays as it is.

## Out of scope

Editing anything on a locked order (Reopen remains the path); the mobile
shell.
