---
id: RS-619
title: PO list: flag a payer chip that no cash flow or bank link backs
type: feature
status: done
priority: P2
created: 2026-11-28
reporter: jinhu
branch: feat/po-list-unbacked-payer-mark
pr:
version: 1.485.0
related: [RS-618]
---

## Ask

> Add an Question Mark when Cost Payment / Commission Linked to a Manager, But not cash flow or payment link.

## Context

RS-618 made the PO list's payment chips `payer | amount`. A payer can be
recorded by name on the PO with nothing in the RMB Flow or the bank feed to
show the money moved.

## Acceptance criteria

- [x] A manager's Cost payment chip shows a ? when Paid by is a person and
      the PO has no live purchase entry and no linked bank row.
- [x] A manager's Commission payment chip shows a ? when a manager paid the
      commission and the PO has no live commission entry.
- [x] Business Account, Self-paid and Not recorded chips never show one;
      purchasers never see it.

## Out of scope

The mobile PO list.
