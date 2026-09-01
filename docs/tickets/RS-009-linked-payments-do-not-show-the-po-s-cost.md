---
id: RS-009
title: Linked payments do not show the PO's cost
type: story
status: in-progress
priority: P2
created: 2026-08-31
reporter: Jinhu
branch: session/20260831-224248
pr: 236
version: 1.117.0
related: []
---

## Ask

> in this page, for each linked payment, it should also show the cost on the side

> next to the Purchase order

Sent with a screenshot of the desktop Payments page on its **Linked** tab —
columns DATE / SOURCE / PAYEE / AMOUNT / STATUS / PURCHASE ORDER, sixteen rows,
each one ending in a bare PO pill (`PO-1400`, `PO-1407`, `PO-1391`, …).

## Context

The PURCHASE ORDER column renders the PO id and nothing else.  The money that
moved is in the AMOUNT column two columns to its left.  So the question a
manager is actually asking while scanning this list — *did this payment cover
that PO?* — can't be answered from the row; it needs a trip into the PO.

The screenshot shows why that matters: `PO-1412` appears on two separate
$2,800.00 rows.  Whether that PO is now paid in full, over-paid, or still short
is invisible.

An unlinked row already carries this number — the suggestion list inside the
expanded row prints the candidate's id and its cost side by side.  A row loses
it the moment it is linked, which is precisely when it becomes checkable.

**Which number "the cost" is.**  A PO's cost is a two-part stack:
`orders.total_cost` (the goods — the line sum, or a negotiated lot price) plus
`orders.other_fees` charged on top (PayPal processing, freight, customs, a
bought label).  `lib/poTotals.ts → poEffectiveCost` is the shared definition and
`CostTape.tsx` renders it as the PO's cost on the PO page.  Goods alone would
read *short of the payment sitting next to it* on most fee-carrying POs — which
is why the matcher already matches a payment against `total_cost` **or**
`total_cost + other_fees` (`banktx/match.ts`: "other_fees … is a separate column
the bank very much did charge.  Matching only the goods total misses every PO
with a fee bigger than TOL_MAX, i.e. most").

So the column shows what the bank was asked to pay, which is what the AMOUNT
column beside it did pay.

## Acceptance criteria

- [ ] A linked row on the Payments page shows the PO's cost immediately after
      the PO pill, in the same cell.
- [ ] That cost is goods + other fees — the same figure the PO detail page
      shows — so on a fee-carrying PO it equals the payment rather than falling
      short of it.
- [ ] A PO with no stored goods total shows no figure, not `$0.00` and not a
      fees-only number.
- [ ] Unlinked, ignored and transfer rows are unchanged: the link/ignore
      buttons still occupy that cell with no stray placeholder.
- [ ] A page served against a backend that predates the change still renders
      (the field is read defensively).

## Out of scope

- Any paid / short / over-paid verdict, or a variance badge.  The number is
  shown; the eye does the comparison.
- The goods-only cost the *unlinked* suggestion list prints — a separate
  surface, left as it is.
- The PO-side payments ledger on the order page, which already sits next to
  that PO's own cost tape.

## Notes

Plan reviewed by a subagent before implementation.  Its one substantive finding
changed the ticket: the first draft showed `orders.total_cost` alone, and the
review surfaced the goods-vs-fees split above.
