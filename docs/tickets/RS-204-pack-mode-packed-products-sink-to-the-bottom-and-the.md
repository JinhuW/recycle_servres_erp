---
id: RS-204
title: "Pack mode: packed products sink to the bottom, and the tick writes the count onto the sell order"
type: story
status: done
priority: P2
created: 2026-10-08
reporter: jinhu
branch: feat/pack-mode-packed-sink
pr: "#551"
version: 1.228.0
related: [RS-187, RS-188, RS-199]
---

## Ask

> For checked item. It should go to the bottom which is like this:
> [Image #1 — PO Review mode's table: a `CHECKED 1  Hide` divider row with the
> checked line under it]

> I meant the Sell order pack mode

> when i adjust the count here. It shoudl also reflect to the sell order.
>
> when the count is 0, The order of # product should keep it. even the count is 0

Clarified in the session:
- The count reaches the sell order **on the tick**. − / + alone is still a
  draft count, and ticking writes it onto the line. Draft orders only.
- A product **counted 0 keeps its row at its #**. It doesn't sink, and no
  other product's # shifts.

## Context

Pack mode (RS-187, laid out like Review mode since RS-199 / v1.227.0) kept a
packed row in its place, so the list always read #1..#n. That was asked for in
RS-188 (2026-10-07) and kept in RS-199. This ticket reverses it: packed
products sink under a divider, as in the PO's Review mode, so what is left to
pack stays on top.

Pack counts lived only in `sell_order_packs`. A short or 0 pick never reached
the sell order, so Mark shipped stayed blocked until someone matched the order
to the box through Edit order. A Draft claims no stock (the stock check runs
when it leaves Draft), so the tick can write the qty cheaply.

## Acceptance criteria

- [x] A product whose lots are all packed, with a count above 0, moves under a
      **Packed N · Hide / Show** divider at the bottom of the table, newest
      first.
      - Products still to pack stay above in # order.
      - A mixed fold stays up until its last lot is packed.
- [x] A product counted 0 stays at its #, whether ticked or at qty 0. Other
      products keep their numbers.
- [x] Ticking the selected product moves the selection to the next product
      still to pack. A row changing group slides there, unless reduced motion
      is set.
- [x] Hide removes the packed rows and ↑ / ↓ skip them. The divider's Hide /
      Show is ≥ 44px.
- [x] On a Draft, ticking a lot below its qty sets the sell-order line's qty to
      the count, 0 included.
      - The line keeps its id and #.
      - History records the edit.
      - The row reads as packed at full count (or as a 0 row).
- [x] Unticking, Undo, or lowering such a line puts its qty back and keeps the
      count. This is refused (409) if the lot was archived or sold meanwhile.
- [x] A short pick ticked on a Draft no longer blocks Mark shipped.
- [x] Shipped, Awaiting payment and Done orders never have their qty written.

## Out of scope

- The phone shell.
- Remembering Hide across reloads.
- Writing qty on a non-Draft order.
- Raising a line above its ordered qty from Pack mode.
- Bringing a 0-ticked line back after the Undo toast is gone. Edit order does
  that.

## Notes

- Plan: `~/.claude/plans/sprightly-mixing-iverson.md`, reviewed by a Plan
  subagent before approval. The review changed these points:
  - the page keeps a per-line `qtys` map from pack responses, rather than
    re-reading the order (that re-read could race with Undo);
  - the restore runs `validateSellLines`;
  - a stale re-tick keeps the saved pre-tick qty;
  - a typed line's History entry names the line.
- No migration: `sell_order_packs.line_qty` already holds the qty a row was
  written against, which is the qty an untick restores.
- Verified on a local stack: a throwaway DB, and a Draft holding a 3-lot product
  plus four single-lot products across three warehouses, at 1440×900, 1180×820
  and 820×1180.
  - **Full tick:** the product sinks and the selection moves on.
  - **Short tick:** qty 2 → 1 on the order. Untick, re-tick and Undo move it
    2 → 1 → 2.
  - **0 tick:** the row stays at #4 and becomes a *Qty 0* row, with every #
    unchanged. Undo restores it.
  - **Fold:** stays up while mixed and sinks on its last lot.
  - **Hide / Show and keys:** both work, and ↓ skips hidden rows.
  - **Space and scan:** each one packs, moves the row down and moves the
    selection on.
  - **Mark shipped:** enabled once everything is packed.
  - **Activity:** shows `Qty 2→1 SAM-256-248`.

  The slide was not inspected frame by frame. It is Review mode's FLIP
  effect, ported as is.
