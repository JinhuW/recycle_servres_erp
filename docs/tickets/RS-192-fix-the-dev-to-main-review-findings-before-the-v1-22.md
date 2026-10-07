---
id: RS-192
title: Fix the dev to main review findings before the v1.220 release
type: bug
status: in-review
priority: P1
created: 2026-10-07
reporter: jinhu
branch: dev-8
pr:
version:
related: [RS-187, RS-188, RS-185, RS-191]
---

## Ask

> /code-review high dev -> main. fix all issue then release all change to prod.

## Context

`/code-review high` of dev against main (v1.216.0–v1.220.0) reported ten
findings. Most come from RS-188 (v1.219.0): a sell-order line is held at 0
rather than removed so the lines after it keep their #, and "a 0 line claims
nothing" — but several readers and writers still treated a 0 line as a claim,
or skipped every check on it.

| # | Finding | Where |
|---|---|---|
| 1 | A 0 line skips `validateSellLines`, so a PATCH naming a nonexistent lot at 0 hit the FK as a 500, and a new line could be added at 0 against an archived or unsellable lot | `routes/sellOrders.ts`, `services/sellOrderCreate.ts` |
| 2 | Both packing lists wrote a workbook with no sheets for an order whose lines are all 0 — a corrupt file in Excel | `GET /api/sell-orders/:id/packing-list` |
| 3 | PO archive counted a 0 sell line as a claim: it blocked the archive, and `removeFromSellOrders` deleted it, renumbering the sell order | `services/orderAdvance.ts` |
| 4 | PO line removal was refused for a lot named only by a 0 sell line | `routes/orders/patch.ts` |
| 5 | The packing-list warehouse picker listed a warehouse holding only 0 lines; picking it got a 400 | `DesktopSellOrders.tsx` |
| 6 | Pack mode showed "Loading" forever when the order itself failed to load | `DesktopSellOrderPack.tsx` |
| 7 | Scan-thumbnail fetches left error bodies unconsumed | `lib/scanThumbnails.ts` — deleted by RS-191 (v1.220.1), nothing to do |
| 8 | Review mode kept its own copy of the line save queue that `useLineSaveQueue` was extracted from | `DesktopBoxCheck.tsx` |
| 9 | The phone PO page fetched the full member list (lifetime profit included) on every open, for the commission paid-by picker | `pages/OrderDetail.tsx` |
| 10 | Field labels for audit diffs lived in two maps that had to be kept in step | `DesktopActivity.tsx`, `lib/orderPresentation.ts` |

## Acceptance criteria

- [x] A sell-order save may hold at 0 only a lot already on the order; a 0
      line for any other lot, or an unknown id, is a 400, not a 500.
- [x] An order whose lines are all 0 gets a 400 from both packing lists, and
      the desktop disables both packing-list buttons for it.
- [x] The warehouse picker lists only warehouses with something to pack.
- [x] Archiving a PO leaves a sell line held at 0 alone — not a conflict, not
      removed — and the archive dialog's line count ignores 0 lines.
- [x] A PO line named only by sell lines held at 0 can be removed; those
      lines keep their # as typed lines.
- [x] The transfer "Drafts name this line" prompt and the MCP `draftCount`
      ignore Drafts that hold the lot only at 0.
- [x] Pack mode shows an error with Try again when the order cannot be loaded.
- [x] Review mode saves through `useLineSaveQueue`; ticking, counting,
      editing a line and reloading behave as before (Approve uses the same
      `flush`, unchanged from the copy it replaces).
- [x] The phone PO page asks for the member list only when the Commission
      fold opens.
- [x] One field-label map serves the Activity page and the PO timelines.
- [ ] dev is released to main and prod health reports the new version.

## Out of scope

- Archiving with `removeFromSellOrders` still deletes the sell lines that do
  hold qty, which renumbers that sell order. Zeroing them instead would follow
  RS-188's idea but changes the archive's behaviour and audit events.

## Notes

Plan: `~/.claude/plans/sparkling-snuggling-clock.md`. The same `qty > 0` rule
was also missing from the transfer Draft prompt (`routes/inventory.ts`) and
`services/sellableInventory.ts`; both were fixed here.

Review mode's line edit used to reach into its own queue to swap a pending
write for a cleared check; on the shared hook that is `save()` then `flush()`,
which also reports a failed write instead of swallowing it. Pack mode's bottom
bar said "Everything is packed." while the order had not loaded — fixed with
the load error.

Verified on a local stack (throwaway DB, Playwright): picker and disabled
buttons on 0 orders, Pack mode error + Try again, a tick, a lowered count and
a qty edit in Review mode reaching the server, no `/api/members` read on a
phone PO until the Commission fold opens, and the Activity page label.
