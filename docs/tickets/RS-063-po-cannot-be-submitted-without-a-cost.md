---
id: RS-063
title: PO cannot be submitted without a cost
type: story
status: in-progress
priority: P2
created: 2026-09-17
reporter: jinhu
branch: feat/po-cost-required
pr: 347
version:
related: [RS-050]
---

## Ask

> user can not submit an PO without cost.

Then, on the first cut, which listed the cost beside the hand-off dialog's
own blockers:

> pls use a diaglog instead of this type of error.

## Context

"Submit" is leaving Draft. Three doors do it — the hand-off dialog
(`POST /api/orders/:id/handoff`), a manager stage-jump (`POST /:id/advance`)
and the carrier tracking poll — and all three run `advanceOrderTx`, which
already holds two leave-Draft rules: the company-pay transaction id and the
self-paid chat screenshot (RS-050). Nothing looked at the money. Every
client serialises a blank unit cost as `0`, the DB has no `unit_cost > 0`
check, and the advance never read the lines.

Production on 2026-09-17: 43 of the 125 submitted (non-draft, unarchived)
POs carry a `total_cost` of 0, holding 514 of 1467 lines at `unit_cost` 0.
Only 6 submitted POs mix a $0 line into a positive total, and 17 carry a
negotiated lot price that differs from the line sum. So the failure is whole
POs going out at $0, not the odd free line thrown in with a lot.

The rule is therefore per order: a PO leaves Draft only when its goods cost
(`orders.total_cost`, re-derived from the lines after every line write or
pinned to the negotiated lot price) is above zero. A $0 line inside a priced
lot stays legal, as `lineRequirements.ts` documents, and a negotiated price
over zero-priced lines still passes. Other fees do not count: freight on
free goods is still a PO without a cost.

Unlike the transaction-id rule there is no creation-date cutoff — a cost can
always be added to an old Draft — and POs already past Draft are untouched.

## Acceptance criteria

- [ ] A Draft whose every line is at $0 is refused by `/advance` with a 409
      naming the cost, and stays in Draft.
- [ ] The same Draft is refused by `/handoff` with the same 409.
- [ ] A manager stage-jump (`toStage`) on that Draft is held to the rule.
- [ ] The empty draft shell from `POST /orders/draft` is refused, and the cost
      refusal comes before the transaction-id one.
- [ ] Once a line's unit cost is saved, the same Draft advances.
- [ ] One priced line plus one $0 line advances (the rule is per order).
- [ ] A negotiated lot price over $0 lines advances.
- [ ] Clicking In Transit on a $0 Draft (desktop stepper or phone advance
      button) raises a "Can't submit yet" dialog naming the missing cost
      instead of opening the hand-off; once a cost is saved the hand-off
      opens as before.
- [ ] The carrier tracking poll logs a warning naming the missing cost when
      it cannot advance a $0 Draft, as it does for the other two rules.

## Out of scope

- Requiring a cost on every line — the per-line $0 convention stays.
- Blocking creation of a $0 Draft: the phone autosaves partial drafts and the
  desktop Submit page creates a Draft first.
- Backfilling the 43 submitted $0 POs already in production.
- A free lot that only carries other fees (freight on free goods) is now
  blocked; that is intended.
- A client-side pre-check for a manager's desktop-stepper stage-jump on a $0
  Draft — that path relies on the server's 409 toast.

## Notes

The guard is placed first among the leave-Draft rules because it is the
cheapest (no query) and the client checks it first as well.

The first cut listed the cost among the hand-off dialog's inline blockers
(source, delivery, transaction id). Jinhu asked for a dialog instead, and
that is the better shape: those three are fixed inside the hand-off, the
cost is fixed on the page behind it, so the page raises the error before
the hand-off opens — the same treatment an unsaved edit gets.
