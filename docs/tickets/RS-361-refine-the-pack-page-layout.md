---
id: RS-361
title: Refine the Pack page layout
type: bug
status: in-review
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/tunicate
pr:
version: 1.317.5
related: []
---

## Ask

> Refine the UI here:
> [Image #2]

## Context

The screenshot was of Pack mode (`#/sell-orders/SO-4001/pack`, desktop
shell) with the AMS warehouse picked. It reproduces locally on the seeded
SO-4001, and its faults are in the code:

- **The progress card is broken.** `.pk-tally` borrows Review mode's
  `.bc-tally`: a two-column grid with no padding, built for two
  `.bc-tally-half` children. `DesktopSellOrderPack.tsx` puts three bare
  children in it. The count sits flush in the card's corner, the meter is
  glued to the top edge across the right half, and *Packing from* wraps onto
  a second row, where it floats mid-card.
- **The fraction doesn't say what it counts.** The head says "6 products ·
  14 units" and the card "1 / 1". With a warehouse picked, the card counts
  only that warehouse, and nothing on it says so.
- **Selection and "packed" use the same green.** `.table tr.row-selected`
  paints `--accent-soft`, and in Pack mode green means packed: the tick, the
  meter, the *packed* chip. An unpacked selected row reads as done, and a
  packed selected one becomes a solid mint slab.
- **An empty photo slot takes most of the side panel.** *No photo on this
  product* keeps a 4:3 grey box, which pushes Finish (Mark shipped) below the
  fold on an iPad.
- **Every row without a photo shows a bordered grey placeholder tile**, a
  column of identical boxes.

Pack mode's layout dates from v1.227.0. The fix stays inside the ERP's
tokens, cards, chips and `.seg`, so the page still reads as a mode of the
order page, as Review mode does.

The screenshot's "Label printer off / Connect" control exists on no branch or
worktree here, so it is left alone.

## Acceptance criteria

- [x] The progress card is one padded row: the count, the product map with its
      legend, and the warehouse picker on the right. Nothing touches the
      card's edges at 1440, 1280 or 1080 wide. At ≤ 900px the picker sits on
      its own row.
- [x] The count is captioned *products packed*, or *products packed,
      {warehouse} only* when one is picked. Units show at the end of the
      legend.
- [x] The map has one cell per product with lots, in # order, labelled `#n`:
      - green when packed, amber when short, red when not packed;
      - a dashed empty slot while waiting.

      Its buckets agree with the legend chips. Labels drop when cells get too
      narrow.
- [x] In Pack mode a selected row shows an ink frame on a neutral wash, never
      the green fill. A selected "choose" row keeps its amber rail.
- [x] With no photo, the Selected card shows a one-line note in place of the
      4:3 slot.
- [x] Placeholder thumbnails have no border or fill, and the column keeps its
      width.
- [x] Reduced motion turns off the cell colour transition.

## Out of scope

- Tapping a map cell to jump to its product.
- Review mode's tally: its two halves already lay out correctly.
- The mobile shell.
- The label printer control in the screenshot.
- The line label repeating the part number ("CPU — Xeon Gold 6248
  OTH-72017"). That is the line's data, not the page.

## Notes

- The map's buckets come from `productBucket` in `lib/sellOrderPack.ts`,
  which `productTally` now loops over, so the cells and the chips can't
  disagree.
- The selection is a frame and not a left rail, because a scan's "choose"
  row already uses a left rail.
- Waiting cells are dashed, empty slots. Solid outlined cells sat beside the
  warehouse switch's buttons and looked tappable.
- The span inside each cell draws it. A container query styles only what is
  inside the container, so a cell too narrow for its # can drop the label
  and the dashes; there, waiting cells become plain grey bars.
- The app has no dark theme, so a dark-theme criterion was dropped.
- Verified locally on SO-4001 at 1440, 1280, 1080 and 820 wide. ↑ / ↓ move
  the frame, and Space packs and moves it on to the next open product.
