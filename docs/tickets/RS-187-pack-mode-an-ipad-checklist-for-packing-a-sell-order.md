---
id: RS-187
title: Pack mode: an iPad checklist for packing a sell order
type: story
status: done
priority: P2
created: 2026-10-07
reporter: jinhu
branch: dev-4
pr: "#519"
version: 1.218.0
related: [RS-124, RS-145]
---

## Ask

> I would like to create an pack mode which is focusing on create a checklist for all item in a sell order which is similiar to the review mdoe in the PO.
>
> But the pack mode is in the sell order should show all item source. like the PO-1111 #1
>
> User may use this in the Ipad.

## Context

Packing a sell order today means printing the **Packing list** xlsx
(`GET /api/sell-orders/:id/packing-list`, tick boxes on paper) or reading the
sell order page; nothing records what went into the box. PO Review mode
(`#/purchase-orders/:id/check`, `DesktopBoxCheck.tsx`, v1.188.0–v1.213.0) is
the inbound mirror: a full-window checklist whose counts start full, a tick
sinks the line, progress lives on the server, a scanner ticks lines, and
Approve finishes the job.

Stock is found on the shelf by the lot's PO and its `#` on that PO
(`sourceOrderId` + `sourceLineNo`, `lib/poLineNo.ts`, RS-145), so every pack
line leads with that. An iPad gets the DesktopApp shell (every iPad is ≥ 744px;
the phone cutoff is 720px), and the desktop CSS has almost no touch handling,
so the page is built touch-first.

`sell_order_lines.id` is not stable — a PATCH that sends `lines` deletes and
re-inserts every row — so pack progress keys on the line's identity (the lot,
or a hand-typed line's text), not its row id.

## Acceptance criteria

- [x] The sell order page head shows **Pack mode** (manager); it opens `#/sell-orders/<id>/pack`, a full-window page with no sidebar or top bar.
- [x] Every line shows its source as a `PO-1111 #1` tag (the `#` matches the PO page); a hand-typed line reads *No PO*.
- [x] Open lines are grouped by source PO in numeric order, lines in PO order, hand-typed last; a warehouse filter appears when the order's lots sit in more than one warehouse.
- [x] Each line's count starts at its qty; − / + change it; the tick confirms the count; a ticked line sinks under *Packed*, newest first, with Undo.
- [x] Lowered below qty = *short* (amber), lowered to 0 = *not packed* (red); both still need their tick.
- [x] A label scan (Bluetooth / USB scanner, nothing focused) ticks the matching line by part number, prefix or serial, like Review mode; when the part sits on lines from more than one PO it highlights them and asks which lot was packed instead of ticking.
- [x] Progress is saved on the server and survives a reload, a second iPad, and an edit of the order's lines; a line whose qty changes comes back unpacked, unless it was packed short and edited down to exactly its count.
- [x] With every line packed at full count on a Draft order, **Mark shipped** opens the Shipped evidence dialog (note + packing photos) and moves the order to Shipped. Short or 0 lines block it and point to Edit order.
- [x] Every tap target is ≥ 44px and the tick is 56px. Nothing depends on hover. Portrait (≈820px) and landscape (≈1180px) iPad both lay out without horizontal scroll.
- [x] The pack endpoints 403 a purchaser; an archived or Closed order opens read-only and its writes 409.

## Out of scope

- Phone shell (an iPad in Split View under 720px loads it, and it has no sell-order routes).
- Camera barcode scanning on the iPad — the scan box takes a hardware scanner or typing.
- A Pack mode button on each sell-order list row.
- Changing a sell line's qty from a short count — Edit order does that.
- Live sync between two iPads — the page re-reads when it comes back to the foreground.
- A sell-order history event for packing.
- Moving Review mode onto the new save-queue hook.

## Notes

- Plan: `~/.claude/plans/dynamic-splashing-lighthouse.md`.
- Line key: a picked line is its lot (`inventory_id`); a hand-typed line is an
  md5 of its category/label/part/condition; both get an occurrence suffix
  because the API can put one lot on an order twice. Consequences: editing a
  hand-typed line's text resets its pack state; a lot deleted from inventory
  (`inventory_id` → NULL) flips its line to the typed key and resets it; a line
  removed and later re-added at the same qty reads as packed again.
- Numbers claimed with the peer sessions: RS-185 / 0162 / 1.214.0 are
  commission-paid-by's; this ticket takes 0163 and 1.215.0.
