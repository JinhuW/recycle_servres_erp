---
id: RS-199
title: Pack mode reads like Review mode, with a fold for a product from several PO lots
type: story
status: done
priority: P2
created: 2026-10-08
reporter: jinhu
branch: feat/pack-mode-review-layout
pr: "#541"
version: 1.227.0
related: [RS-187, RS-188, RS-190, RS-193, RS-197]
---

## Ask

> Update the pack mode for the Sell order, You can reference the PO review mode which is much more clear for me.
> for each product if it comes from different PO, a fold section can be used.

Clarified in the session:
- Packed rows → **stay in # order** (RS-188 kept), ticked and dimmed in place.
- A product's fold → **starts closed**; ticking the product packs every lot
  still at full count.
- Mark shipped → **a Finish card in the side panel**, as in Review mode.
- Built on RS-197's scan-box filter, which was in flight in a parallel session.

## Context

Pack mode (RS-187/188, v1.218–1.219) is a card list: one big row per sell line
with a hang-tag `#n`, a photo, a stepper and a 60px tick, and a sticky bottom
bar for Mark shipped and Undo. Since RS-193 (v1.220.3) a product's lines share
one `#`, so a product picked from three PO lots reads as three `#3` rows.

PO Review mode (`DesktopBoxCheck.tsx`) is laid out as:
- a page head;
- a tally card;
- a table with the scan box in its head;
- a side panel with the selected line's photo and a Finish card.

That layout reads more clearly. Pack mode takes the same shape, and a product
from several lots collapses into one row that opens to show its lots.

## Acceptance criteria

- [x] Pack mode has Review mode's shape: page head, tally card, a table with the
      scan box in its head, and a side panel holding the selected item and a
      Finish card. The bottom bar is gone.
- [x] Rows run #1..#n and never move; a packed row dims in place.
- [x] A product with two or more lots above 0 is one fold row: its #, part,
      specs, the lots' PO tags, and the summed count. It starts closed. Opening it
      lists one row per lot with its photo, PO tag, count stepper and tick.
- [x] Ticking a product packs its lots still at full count. A lowered lot keeps
      waiting for its own tick, and the fold opens to show it. Ticking a fully
      packed product unpacks it. One Undo reverses either.
- [x] A scan that could be several lots opens their products and highlights the
      lots. RS-197's filter keeps every product holding a match, with the
      matches showing.
- [x] The Finish card lists what still blocks Mark shipped (left to pack, short,
      zero, with Edit order). With everything packed on a Draft it offers Mark
      shipped → the Shipped dialog.
- [x] iPad landscape (1080 and 1180 wide) shows two columns. Portrait stacks the
      Finish card under the list. No horizontal scroll, and every tap target is
      ≥ 44px.

## Out of scope

- A "Pack all remaining" button (Review mode's *Check all*): packing is per item.
- Any backend change. Pack progress stays per sell line.
- The phone shell.
- Remembering open folds across reloads.
- Letter keyboard shortcuts. RS-197's type-to-filter needs every printable
  first character to start the scan.

## Notes

- Plan: `~/.claude/plans/majestic-coalescing-patterson.md`, reviewed by a Plan
  subagent before approval. The review set Pack mode's own breakpoint (1023px):
  Review's 1100 would have stacked a 1080-wide iPad.
- A lot at qty 0 is dropped from a product that still has a lot above 0, as the
  packing lists drop it. A product whose lots are all 0 stays as one greyed row,
  so its # is still accounted for.
- Verified on a local stack (throwaway DB, Playwright WebKit at 1180×820,
  1080×810, 820×1180 and 810×1080; Chromium at 1440×900) against a draft with
  a 3-lot product, a live lot plus a 0 lot, an all-zero product and three
  warehouses: 54 checks, including no horizontal scroll and every button
  ≥ 44px.
- Released as v1.227.0, not the 1.223.0 first claimed: RS-200 (v1.225.0)
  merged first and `version-check` refuses a version below the newest tag.
