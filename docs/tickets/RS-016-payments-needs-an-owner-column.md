---
id: RS-016
title: payments needs an owner column
type: task
status: done
priority: P3
created: 2026-09-03
reporter: Jinhu
branch: session/20260902-140951
pr: 249
version: 1.121.0
related: [RS-015]
---

## Ask

> pls also add a new column for the assigned person name .

## Context

Follow-on to RS-015, which merged Status and Purchase order into one column and
gave the actions their own rail.  The owner survived that change as it was: a
`Assigned to Sofia Reyes` chip tucked into the Status cell beside whatever that
cell already said.

That placement was a compromise from before — the code comment recording it said
the table was already seven columns wide and an eighth wrapped the header.  It
has three costs.  The owner reads as an annotation on the status rather than a
fact about the payment.  It cannot be scanned down the page, which is the whole
reason to have a column.  And it widens the Status cell on exactly the rows that
carry it.

The queue already filters by owner — the `Anyone` dropdown in the toolbar — so
the one dimension you can slice the list by is the one dimension with no column
of its own.

## Acceptance criteria

- [x] An `Owner` column sits between Amount and Status, showing the assigned
      person's avatar and first name, with their full name on hover.
- [x] A payment with no owner shows a muted em dash, not a blank cell.
- [x] The `Assigned to …` chip is gone from the Status cell — moved, not
      duplicated.
- [x] Assigning and unassigning from the expanded row updates the column.
- [x] The `Anyone` filter still narrows the list to one owner.
- [x] Row heights stay uniform and the table gains no horizontal scrollbar.

## Out of scope

- Assigning from the column itself.  A cell that opens a member picker would put
  a popover on every row; assigning stays in the expanded row where it is.
- The `part of <record>` chip, which stays in the Status cell — it describes what
  the money *was*, not who is handling it.

## Notes

Owner and purchase order are mutually exclusive by construction:
`bank_transactions_assignee_unlinked` (migration 0116) enforces
`assignee_id IS NULL OR order_id IS NULL`, and linking or pairing clears the
owner.  So the column is deliberately all em dashes on the Linked tab and behind
the Refunds tile.

Initials come from the API rather than being derived from the name: a member can
be renamed without their stored initials being recomputed, so deriving would
quietly disagree with every other avatar in the app.
