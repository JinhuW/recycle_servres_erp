---
id: RS-184
title: A PO line may be counted down to 0; only a new line needs qty 1
type: story
status: in-progress
priority: P1
created: 2026-10-07
reporter: jinhu
branch: fix/po-line-qty-zero
pr:
version:
related: [RS-183, RS-124, RS-145]
---

## Ask

> You will update the prod data, so be careful.
>
> I removed two line in the PO-1483. It changed the # order in the PO.
>
> Pls revert them back and allow the count to be 0.
>
> btw, we do have a check for count 0 in the PO. Let we update the workflow and only check when purchaser create a new product (line) in the PO

Clarified in the session:
- Restored lines' qty → **0**. The goods total stays $12,331 and other fees stay $969.
- Where 0 is allowed → **PO line edits only** (PO page, Review mode, phone).
  The inventory stock editor keeps ≥1. Stock lists never show a 0-unit row.
- What Review mode's Approve does with a line ticked at 0 (RS-183, on dev only)
  → **keep it at qty 0**, instead of deleting it.

## Context

PO-1483 was at Reviewing on prod (v1.211.0). Two lines had none of their units
in the box:
- #32: M393A2K43EB3-CWEBY ×4 @ $25, a 14 ms double-submit of #31.
- #36: HMA82GR7CJRAN-VK ×1 @ $25.

`order_lines.qty` carried `CHECK (qty > 0)` and every edit path refused 0, so
the only way to record "nothing arrived" was to delete the line. Deleting
renumbers every line after it, because a line's `#` is a live rank (RS-145).
The two lines were deleted at 01:49 UTC on 2026-10-07, and the $125 moved into
other fees.

RS-183 (v1.212.0, shipped to dev the same evening) made Review mode's Approve
delete lines ticked at 0. That is the same renumbering, done automatically.

## Acceptance criteria

- [ ] Editing an existing PO line to qty 0 saves (PATCH `lines`, PO page
      drawer, Review-mode drawer, phone line form on an existing order).
- [ ] A new line still needs qty ≥1: POST `/api/orders`, PATCH `addLines`,
      the new-PO screens on desktop and phone, and the web form. The
      inventory stock editor still needs ≥1.
- [ ] A line committed to a sell order (Shipped / Awaiting payment) can't drop
      below that commitment, 0 included.
- [ ] Review mode: Approve sets lines ticked at 0 to qty 0 and then moves the
      PO. The lines stay on the PO and the `#` order holds.
- [ ] Review mode: a line already at qty 0 is ticked by *Check all remaining*,
      isn't re-zeroed by Approve, and a scan landing on it says it is at qty 0.
- [ ] A 0-qty line is not stock: hidden from the inventory list, export,
      grouped view and analysis. It doesn't keep a Done PO from settling to
      Sold.
- [ ] A DDR5 line counted down to 0 doesn't need serials.
- [ ] PO-1483's two lines come back at qty 0 in their old places (#32, #36),
      by migration, guarded so it does nothing anywhere else.

## Out of scope

- Zeroing counted-0 lines when the PO is moved from the PO page or the phone.
  Only Review mode's Approve does it (unchanged from RS-183).
- Blocking a zero on a line a **Draft** sell order names. Lowering qty under a
  draft's claim was already allowed, the sell picker skips 0-qty lines, and
  promoting the draft fails with "exceeds inventory".
- The PO list's `line_count` and the dashboard's per-category `COUNT(*)` still
  count a 0-qty line. It is still a line on the PO.

## Notes

- Plan: `~/.claude/plans/moonlit-soaring-adleman.md`.
- Restored rows come from the dev DB copy taken at 04:00 UTC on 2026-10-06,
  before the delete.
  - #36's label scan is gone. The removal's post-commit R2 sweep deleted it
    (HEAD 404), so it comes back with no scan image.
  - #32 shares #31's scan key, which survived.
- Lost with the delete and not restored: each line's `Draft→Reviewing` history
  row, and any Review-mode count made 01:36–01:49. The restored lines come
  back unticked.
- A line counted down to 0 keeps any serials it carried, since the count rule
  is skipped at 0.
