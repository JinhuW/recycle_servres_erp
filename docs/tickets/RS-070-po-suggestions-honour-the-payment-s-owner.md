---
id: RS-070
title: PO suggestions honour the payment's owner
type: story
status: done
priority: P2
created: 2026-09-18
reporter: jinhu
branch: feat/match-honours-assignee
pr: 355
version: 1.151.0
related: []
---

## Ask

> The suggestion here should also associated with the assigned person

Sent with a screenshot of the Payments page: a Sep 17 `PayPal + Mercury`
payment of −$500.00 to *Somkid Lor*, assigned to **Harrison**, whose expanded
"Suggested purchase orders" block offered **PO-1386** — a $500 PO belonging
to **Stefen**, 23 days apart and badged `already paid $500.00`.

## Context

A manager can assign an unlinked payment to a member (v1.119.0). The PO
matcher (`apps/backend/src/banktx/match.ts`) ranks candidates by amount,
date gap, transaction id, seller name and purchaser affinity, but never reads
who the payment was assigned to — so a payment the manager has already said
is Harrison's still offers Stefen's same-amount PO, and the row badge, the
`hasMatch` filter and the Suggested tile all count it.

Decisions:

- **The owner gates the pool, it doesn't just rank it.** Assignment is the
  manager's verdict on whose payment this is; another member's same-amount PO
  is the noise the ask is about. The gate lives in SQL, in the shared
  amount/date predicate, so the expanded row, the picker's suggestions, the
  badge, the filter and the tile keep agreeing — a ranking boost could not
  reach the tile's `COUNT(*) FILTER`.
- **A transaction-id hit is exempt.** An exact identifier the purchaser or the
  OCR wrote on a PO outranks a guess about who paid; if it lands on another
  member's PO, the assignment is what's probably wrong, and the manager should
  see it.
- **Typed search in the picker is exempt** — once the manager types, they
  know something the ranking doesn't.
- Unassigned payments are unchanged.

## Acceptance criteria

- [x] `GET /api/bank-transactions/:id/suggestions` on a payment assigned to
      Priya offers Priya's same-amount PO and not Marcus's; `total` counts
      only the offered one. Unassigned, both are offered.
- [x] A PO carrying the payment's PayPal transaction id is offered even when
      it belongs to another member, with `reason: 'txn'`.
- [x] A payment assigned to Priya whose only same-amount PO is Marcus's has
      `match: null` in the list, is omitted by `?hasMatch=1`, and is not in
      `stats.suggested.count`.
- [x] On the Payments page, assigning or unassigning an expanded row
      refreshes its "Suggested purchase orders" block without collapsing it.

## Out of scope

- Reading the owner as a ranking signal on unassigned rows (the `affinity`
  flag already covers "this purchaser has paid this counterparty before").
- Warning when a txn-id hit disagrees with the assignment.

## Notes

- Plan: `~/.claude/plans/velvety-giggling-peach.md`. Ticketed as RS-069 in
  the plan; renumbered when a peer session took RS-069 / v1.150.0 first.
