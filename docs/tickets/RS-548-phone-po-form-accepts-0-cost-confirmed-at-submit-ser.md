---
id: RS-548
title: Phone PO form accepts $0 cost, confirmed at submit; serials sit under Part #
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/shiner
pr: 1105
version: 1.426.0
related: []
---

## Ask

> In the mobile PO mobile product submit page, The price allow 0. But when user move the PO to review. it will ask the user to confirm.
>
> [Image #1]
> move the SN number to under the PN number box.

## Context

`lineRequirements` has required a unit cost above 0 since v1.152.0 (RS-072), so
the phone form refused a free item. `leaveDraftBlockers` also refused a PO that
totals $0 on first submission, so allowing $0 entry alone would have left such a
PO stuck in Draft. A $0 line inside a priced PO already went through without
anyone being told.

Owner decisions, 2026-11-05:

- The confirmation goes on Draft → In Transit, the purchaser's hand-off, while
  they can still correct the price. Purchasers can't make the In Transit →
  Reviewing move.
- A PO where every product is $0 can be submitted after confirming, which
  replaces the hard block.
- $0 entry is phone-only. The confirmation appears on both shells.

## Acceptance criteria

- [x] The phone form saves a typed unit cost of 0. A blank cost is still named as missing.
- [x] Reopening a saved $0 line on the phone shows 0 and saves without retyping.
- [x] The desktop drawer, Submit page and edit page still refuse $0 on a new or touched line.
- [x] First submission of a PO with a $0 line (qty > 0, no negotiated lot price) asks for confirmation on phone and desktop, naming those lines. Go back leaves it in Draft; confirming opens the hand-off.
- [x] An all-$0 PO with units can be submitted after confirming. The server refuses it without the confirmation flag, including from a stale page and from `/advance`.
- [x] A PO with no units still can't be submitted.
- [x] A PO with no $0 lines, a negotiated lot price or earlier submission history sees no question.
- [x] The `submitted` audit event records `zeroCostConfirmed` when the purchaser confirmed.
- [x] Serial numbers renders directly below Part # (and below the RAM short code) for all categories. SSD keeps its existing show/hide rule.

## Out of scope

- $0 entry on desktop.
- A question on In Transit → Reviewing.
- Moving the serial field on desktop.
- A confirm on `/advance` stage-jumps: an all-$0 PO is refused there and goes
  through the hand-off.

## Notes

Two changes from the approved plan:

- Only `/handoff` takes `confirmZeroCost`. The plan also had `/advance` accept
  it, but nothing would send it there, and leaving it out keeps the refusal
  unconditional at that door.
- `poReadiness` takes a count of $0 lines, not units. A header pinned at $0 over
  priced lines has units but nothing to confirm, so it must stay a blocker.

The server's `zeroCost` kind has no entry in `SERVER_BLOCKER_KEY` on purpose:
it is a question put at the move, not an item on the *Before you submit* list.
