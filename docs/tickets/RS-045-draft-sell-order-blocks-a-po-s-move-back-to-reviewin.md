---
id: RS-045
title: Draft sell order blocks a PO's move back to Reviewing
type: bug
status: in-progress
priority: P2
created: 2026-09-13
reporter: Jinhu
branch: session/20260913-001639
pr:
version:
related: []
---

## Ask

> fix a prod issue that PO-1431 does not blong to any open sell order, but it
> still show this

(With a screenshot of the error dialog: "Something went wrong — Lines
committed to open sell orders — cancel those sell orders first.", over a PO
page showing the Reviewing and Ready to Pay stages.)

## Context

Prod, 2026-09-13: PO-1431 sits at Ready to Pay with 30 Done lines. Its two
earlier sell orders, SO-4047 and SO-4048, are both Closed. SO-4056 is a
**Draft** created 26 seconds after SO-4048 was closed, and it names five of
the PO's lines. Moving the PO back to Reviewing was refused with the dialog
above.

The backward-move guard (`committedLineIds` in
`services/orderAdvance.ts`) counted Draft sell orders alongside Shipped and
Awaiting payment. It exists so a sell order never ends up holding lines that
`validateSellLines` rejects — but that check accepts Reviewing *and* Done
lines, so a Draft would still have promoted fine after the move. Refusing it
protected nothing, and the 409 named only line UUIDs, so the user could not
see which sell order was in the way.

For a move to In Transit or Draft (the purchaser-edit revert) a Draft sell
order *would* be stranded, so the Draft rule stays for those targets.

## Acceptance criteria

- [ ] A PO at Ready to Pay or Done whose Done lines sit on a **Draft** sell
      order can be moved back to Reviewing; the draft still promotes to
      Awaiting payment afterwards.
- [ ] The same move is still refused with 409 when a line sits on a
      Shipped or Awaiting-payment sell order.
- [ ] A move to In Transit, and a purchaser revert to Draft, are still
      refused while a Draft sell order names a line.
- [ ] Every such refusal names the sell order IDs (`sellOrderIds` in the
      body, and in the message).

## Out of scope

The per-line qty/status edit guard in `routes/inventory.ts` also refuses on a
Draft sell order. It protects a different invariant (a draft's qty demand
against the line's remaining qty), so it is left as is; revisit if it bites.

## Notes

The rule is keyed on the landing line status: when the lines stay sellable
(Reviewing/Done) only committed sell orders block; otherwise Draft blocks too.
`SELLABLE_LINE_STATUSES` in `lib/sellCommitment.ts` is shared with
`validateSellLines` so the two cannot drift. No prod data fix: SO-4056 is a
legitimate draft.
