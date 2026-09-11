---
id: RS-038
title: Dev-to-main review findings before the prod cut
type: bug
status: done
priority: P2
created: 2026-09-11
reporter: jinhu
branch: fix/dev-to-main-review
pr: 299
version: 1.137.1
related: [RS-036, RS-037]
---

## Ask

> /code-review high dev to main branch. fix all issue and push to main.

## Context

A `high`-effort review of the diff a `dev` → `main` release would ship
(`origin/main...origin/dev`: v1.133.0 – v1.137.0) returned ten findings and
six low items.  All verified against source.  Most sit in RS-037's archive
work and RS-036's payment note, neither of which has been on `main` yet, so
this is the last cheap moment to fix them.

The findings, and what each actually costs:

| | Where | Cost if shipped |
|---|---|---|
| 1 | migration `0121` | A PO archived before v1.137.0 that has a line out on a pending transfer gets that line flipped to `Archived` — the exact strand the runtime guard refuses.  Receive then moves nothing, discard and reopen refuse it forever |
| 2 | `routes/orders.ts` `setArchived` | A purchaser who owns the PO can read the ids, statuses and lines of managers' Shipped / Awaiting-payment sell orders off the 409, then delete those lines with `removeFromSellOrders` — data every `/api/sell-orders` route 403s them on |
| 3 | `routes/inventory.ts` PATCH | The archived guard keys on the line status, so a Sold line on an archived PO can be PATCHed back to `Done` and re-enters stock while the PO stays archived; a later unarchive ignores it |
| 4 | `routes/inventory.ts` analysis | No status predicate: archived goods still count in every KPI and a stray `Archived` bucket appears in the pipeline — contradicting the release notes |
| 5 | `services/orderAdvance.ts` conflict payload | One entry per `sell_order_lines` row keyed by `inventoryId` in both dialogs — duplicate React keys when a sell order names the same lot twice |
| 6 | `routes/bankTx.ts` feed | A per-row LATERAL scan compensates for `autoPair` not copying the note across, while `/pair` does copy it.  The invariant `0120` promises ("written to every leg") is broken for every auto-paired group |
| 7 | `DesktopEditOrder.tsx` | An archived In Transit / Reviewing PO says "This order is Done — it can no longer be edited" under a banner that says it is archived |
| 8 | `OrderDetail.tsx` | Mobile shows "Completed — order is read-only" on an archived PO at any stage, next to the archived banner |
| 9 | `desktop.css` | `.pay-note` uses `var(--muted)`, which is defined nowhere — the note renders as primary text |
| 10 | both archive dialogs | ~45 lines duplicated byte-for-byte between the shells |

Low: the sidebar "+" badge is hidden in rail mode; a deploy-skew comment
cites the wrong version; RS-037's index row lacks its version; `NOTE_MAX`
duplicated across backend and frontend; the open-sell-order status literal
appears in four TS sites.

## Acceptance criteria

- [x] A migration puts every `Archived` line on a pending transfer back to
      `In Transit` with its audit row; replaying `0121` then the repair on a
      transferred, archived-by-flag PO leaves the line at `In Transit`.
- [x] A purchaser's archive of a PO whose lines sit on open sell orders
      returns a plain 409 with no `code` / `sellOrders`, and
      `removeFromSellOrders` from a purchaser removes nothing.
- [x] `PATCH /api/inventory/:id` refuses with 409 "archived" for any line
      whose parent PO is archived, Sold included.
- [x] `GET /api/inventory/analysis` excludes `Archived` lines from every
      aggregate; archiving a PO drops `totals.units` by its qty.
- [x] The conflict payload carries a `solId` per line and both dialogs key on
      it.
- [x] `autoPair` and `transferPair` copy a lone note across the pair; the feed
      reads `bt.note` directly; a migration backfills pairs made before this.
- [x] Both shells say "archived" — not "Done" — when an archived PO refuses
      an edit.
- [x] `.pay-note` renders muted.  The "+" badge survives the icon rail.
- [x] Backend + frontend suites, typecheck, and build all green; `dev` then
      `main` carry the release.

## Out of scope

- Analysis still counts `Sold` lines (pre-existing, before this release).
- `autoPair` does not copy `assignee_id` / `internal_txn_id` across either
  (same gap, pre-existing).
- Closed sell orders naming archived lines dead-end on reopen (pre-existing).
- `sellOrders.ts` `ADJUSTABLE_STATUSES` coincides with the open-sell-order
  set but is a different concept; left alone.

## Notes

`0121` is already applied on `dev`, so it is repaired by `0122` rather than
edited; prod runs both at the next boot.
