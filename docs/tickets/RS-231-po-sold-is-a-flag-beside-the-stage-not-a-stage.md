---
id: RS-231
title: PO Sold is a flag beside the stage, not a stage
type: story
status: done
priority: P2
created: 2026-10-11
reporter: jinhu
branch: feat/po-sold-flag
pr: "#609"
version: 1.246.0
related: []
---

## Ask

> One thing i would like to clearify. I think i mislead the PO. status.
>
> Instead of Sold status should not be part of the workflow. [Image #5]
> It should be an seperate status of an PO.
>
> The sold status can happen in any stage after in transit. Done may show with sold together.

Clarified in the same conversation:

- Q: When does a PO count as Sold? — A: Every line sold.
- Q: Which stages can carry it? — A: In Transit and later.
- Q: How should the list filter chips work? — A: Sold chip filters by flag;
  stage chips count every PO under its real stage.
- Q: Who sees it? — A: Managers only, as today.

## Context

Since v1.164.0 `orders.lifecycle = 'sold'` is a stage after Done
(`services/orderSold.ts` flips a Done PO whose every line is Sold). The list's
chip rail therefore splits Done in two (Done 6 / Sold 18), the stepper relabels
Done as Sold, and a PO that sold out while still at Ready to Pay shows nothing.
Selling is not a workflow step: stock is sellable from In Transit on, so a PO
can be sold out at any stage from there.

## Acceptance criteria

- [x] No PO has `lifecycle = 'sold'`; existing ones are moved back to `done`.
- [x] A PO at In Transit, Reviewing, Ready to Pay or Done whose every qty>0
      line is at line status Sold carries a `sold` flag (managers only); Draft
      never does.
- [x] The flag is derived from the lines, so adding a non-Sold line or walking
      a line off Sold clears it with no further action.
- [x] The desktop PO list counts every PO under its real stage; a separate Sold
      chip toggles a filter on the flag and combines with a stage chip.
- [x] Desktop and phone list rows show a Sold badge beside the stage pill.
- [x] The PO page (desktop and phone) shows the real stage plus a Sold badge
      and the sold-out panel naming the sell orders.
- [x] Purchasers never see Sold, as before.
- [x] Commission and dashboard figures are unchanged.

## Out of scope

- A "partly sold" badge.
- A stored `sold` column — the flag is computed from the lines when read.

## Notes

- The inventory editor's lock that refused to walk a line off Sold on a sold
  PO is dropped: it only existed because nothing could un-settle `sold`.
- Old `advanced done→sold` activity rows stay in the table but are no longer
  shown.
