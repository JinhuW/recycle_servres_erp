---
id: RS-205
title: Pack mode applies the flagged short counts to the sell order
type: story
status: done
priority: P2
created: 2026-10-08
reporter: jinhu
branch: feat/pack-apply-short
pr: "#554"
version: 1.229.0
related: [RS-204, RS-188, RS-199]
---

## Ask

> Once user flag out the short, It should also have the ability to apply it back the sell order. But keep in mind. for the product short to 0. It should still keep the place or keep the # in the sell order. cuz i already create a marker on each product while i am counting them to make it easy for next guys to review it.

## Context

Since v1.228.0 (RS-204) the **tick** writes a lot's count onto a Draft's
line. Lowering the count with − only flags the lot, as amber *Short* or red
*Not packed*. Three things hid that:

- the page never says the tick is what writes the count;
- a product row's tick skips lowered lots on purpose;
- the Finish card lists only lots that were *ticked* short.

On 2026-10-08 prod held SO-4082 (Draft, 362 lines) with 26 lots lowered to 0
and never ticked, and SO-4080 with five more. None of them had reached the
order, and the page had no way to send them all.

The # half already holds. A tick at 0 updates the line in place to qty 0,
keeping its id:

- `foldSheetLines` numbers 0 lines and places a product by its first line, 0s
  included;
- Edit order accepts 0 lines;
- Pack mode keeps a product whose lots are all at 0 at its # as the greyed
  *Qty 0* row.

What was missing is the apply action.

## Acceptance criteria

- [x] On a Draft, while any packable lot is counted below its qty and not
      ticked, the Finish card shows **Apply n to the order**. This holds even
      while other products are still left to pack. With it come:
      - a hint: each line goes to its count as an edit would, which clears a
        price adjustment, and a 0 line stays on the order at its #;
      - the list of those lots (`#12 PO-1111 #4 · Counted 0 of 2`).
- [x] Apply sends one request. For each listed line it:
      - sets the qty to its count, 0 included;
      - edits the line in place, so its id and its # stay the same on the order
        and in Pack mode;
      - marks it packed;
      - records the edit in History.
- [x] After Apply:
      - a lot applied at 0 leaves its product;
      - a product with every lot at 0 stays at its # as the *Qty 0* row;
      - a product whose lots are now all packed sinks under *Packed*.
- [x] One Undo in the toast puts every applied line's qty and count back.
- [x] Shipped, Awaiting payment, Done, Closed and archived orders show no
      Apply, and the endpoint refuses them (409).
- [x] A line that is no longer flagged on the server is skipped, not refused.
      That covers a lot another iPad ticked and an order edited meanwhile.

## Out of scope

- Writing qty on a non-Draft order.
- Making − / + alone write the qty. RS-204 chose the tick.
- Lots ticked short before v1.228.0. No prod Draft has one, and re-ticking one
  can't be undone, so Edit order keeps covering them.
- Renaming the *Not packed* flag.
- The phone shell, since Pack mode is desktop-only.

## Notes

- Plan: `~/.claude/plans/shiny-kindling-teacup.md`. A Plan subagent reviewed
  it before approval, and the review changed four things:
  - Apply became one batch endpoint (`POST /api/sell-orders/:id/pack/apply`),
    one transaction under one `sell_orders` lock, instead of N parallel
    locking PUTs. N PUTs would have held the pool (max 10), and a stale second
    iPad would have drawn one 409 dialog per line.
  - The selection resets when a fold shrinks.
  - The strings got singular forms.
  - The FEATURES edits cover the Finish card and Mark shipped as well.
- The selection moves on after Apply as it does after a tick. It is judged on
  the reply, since a fold that lost a lot to 0 can turn into a single row
  under another key.
- Verified with a scripted WebKit iPad (gen 7: 1080×810, then 820×1180)
  against a throwaway DB. The Draft held:
  - a 3-lot fold and a 2-lot fold, made by duplicating PO lines;
  - four single-lot products.

  Results:
  - **Flagging:** one single lot lowered to 0, a lot of each fold lowered to
    0, one lot short, and each fold's full lots ticked. The Finish card
    listed 4.
  - **Apply:** one POST and no PUTs. The qtys went 2→0, 2→0, 2→0 and 4→2, and
    every `no` was unchanged. The single 0 product stayed at #2 as *Qty 0*.
    Both folds and the short lot sank under Packed, and the selection moved
    to #4. History recorded four edits.
  - **Undo:** four PUTs, and every qty was back.
  - **Shipped order:** no Apply button, and the endpoint returned 409.
