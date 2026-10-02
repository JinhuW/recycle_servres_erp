---
id: RS-146
title: "Stock math and lock order: one free-quantity rule, PO qty vs committed, deadlock-free locking, lot-price reset"
type: bug
status: done
priority: P1
created: 2026-10-02
reporter: jinhu
branch: fix/stock-math
pr: "#464"
version: 1.197.0
related: [RS-130, RS-134, RS-144]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

This is Batch 5 of the approved plan,
`docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`. It covers
review findings M40, M13 and M14, plus the draft-named full transfer and the
transfer modal cap.

## Context

- **M40: "how much of this line is free" was computed at about ten call sites.**
  Each was a hand-written subquery over committed sell orders, and they had
  drifted apart. The inventory editor refused *any* qty edit while a single
  unit was committed (an EXISTS test). `validateSellLines` ran one query per
  line. The transfer modal offered the whole lot, though the server would only
  move the uncommitted part.
- **M13: the PO editor could cut a line below what was committed.** PATCH
  /api/orders/:id wrote `qty` with no committed check, and nothing locked the
  lines, so a promotion could stake a claim between the read and the write. A
  recount of a partly sold line moved `qty` but not `qty_purchased`, so units
  already sold reappeared or vanished from the PO's cost.
- **M14: transactions locked rows in different orders.**
  - PO PATCH and the advance lock the order row and then the lines.
  - The inventory editor and a sell order's Done lock the lines first and only
    later update `orders`.
  - Every order lock was `FOR UPDATE`, which conflicts with the `FOR KEY SHARE`
    a transfer's line INSERT takes on its parent order.

  The result was 40P01 deadlocks, reproduced on 1.196.1 as 500s in
  `tests/stock-lock-order.test.ts`. Separately, a pinned `total_cost` (a
  negotiated lot price) could only be cleared by hand in psql, and PO-1339
  still double-counted $8,500.

## Acceptance criteria

- [x] One helper (`committedQtySql` / `committedClaimsByLine` in
      `lib/sellCommitment.ts`) computes committed units. A line with 2 of N
      committed reads N−2 free in the sell-order picker, the sell order's
      maxQty, the transfer refusal, the inventory list (`committed_qty`) and
      both editors.
- [x] The inventory editor allows a recount that stays at or above the
      committed units, refuses one below (409 with `committedQty`), and refuses
      a status change while anything is committed.
- [x] PO PATCH refuses a qty below the committed units with 409, naming the
      sell order to a manager. Both editors move `qty_purchased` by the same
      delta as `qty`.
- [x] Every non-deleting order lock is `FOR NO KEY UPDATE`. The inventory
      editor and sell-order Done lock the source orders (sorted) before any
      line. Concurrent inventory edit + PO PATCH, partial transfer + PO PATCH,
      and Done + PO PATCH never 500, and the total matches the lines.
- [x] `POST /api/orders/:id/total-cost/follow-lines` (managers) drops a pinned
      lot price and audits it as a `total_cost` change. The PO cost card shows
      "Negotiated lot price" and a "Follow line total" button on desktop and
      phone, read from the server's `goodsFollowsLines`.
- [x] A whole-line transfer of a line a Draft names answers 409
      `{needsConfirm, drafts}` unless `confirmDrafts: true`. The modal asks,
      naming the drafts, caps each line at its uncommitted units, and says how
      many are committed.
- [x] Migration 0148 zeroes PO-1339's stale total, guarded on its id, the
      $8,500 and an empty line set.

## Out of scope

- The other 11 prod POs whose total differs from their lines. Most are real
  lot prices; they are listed in the PR for review, and the new button is how
  any of them gets reset.
- The PO PATCH remove-line check (`stillNamed`). It asks "does any open order
  still point at this line", not "how much is free", so it keeps its own
  query.

## Notes

- The reset writes an ordinary `meta_changed` event on `total_cost`, not a new
  event kind: every activity view already renders it, and a new kind is five
  places to wire.
- `goodsFollowsLines` comes from the server because the PO page's lines carry
  what is *left*, while the mirror verdict is on what was *bought*. Judged
  client-side, every partly sold PO read as negotiated.
