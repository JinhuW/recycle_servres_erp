---
id: RS-003
title: Mobile PO add-item buttons require scrolling past the whole line list
type: story
status: in-review
priority: P2
created: 2026-08-31
reporter: Jinhu
branch: session/20260831-144457
pr: 226
version: 1.109.0
related: []
---

## Ask

> Optimize the UIUX of submitting product in the PO. when i click the edit of
> exitsing po and submit an item.
>
> When i try to add more item. it alwasy ask me to scroll to button to click
> the for add buttoms.
>
> Think of moving the add four type item button to the button and move the
> status update with the order status section?

Then, clarifying the shell:

> it is mainly for the mobile view

## Context

On mobile, editing an existing PO opens `OrderDetail` (`/purchase-orders/:id`).
The four category add-targets sat in the scroll flow *below the whole product
list*. Saving a line navigates away to `SubmitForm` and back
(`MobileApp.tsx` `startAddLine` → `goBack` → `navigate('/purchase-orders/'+id)`),
which remounts `OrderDetail` and resets `.ph-scroll` to the top. So every added
item pushed the add buttons one row further down, and every return trip started
the scroll again from the top — the feature got harder to use the more it was
used.

Asked which of two readings he meant, Jinhu chose docking the buttons above the
bottom action bar. He also confirmed the second half of the ask needed no work:
the stage-advance button (`Submit to In Transit` / `Mark Done`) is already
inside the Order Status card.

## Acceptance criteria

- [x] The four `+ RAM / + SSD / + HDD / + Other` targets are visible on the PO
      edit screen without scrolling, at any scroll position.
- [x] Each remains a direct, single-tap target for its category — no "Add
      another" button and no category mode.
- [x] Returning from the line form lands back on the PO with the targets still
      on screen.
- [x] The bottom of the scroll (Activity log) still clears the taller bar.
- [x] A locked (Done) order shows no add targets and its action bar is
      unchanged.
- [x] The other `.ph-action-bar` screens (line form, order review, shipping,
      vendor portal) are unaffected.

## Out of scope

`OrderReview.tsx` — the *create* flow — carries the same add block in the same
in-flow position. Jinhu's report was about editing an existing PO, and a new
order's list is built in one sitting with the user already at its bottom, so
that screen was left alone.

## Notes

The bar became a two-row stack (`.ph-action-bar.stacked`) rather than gaining a
second absolutely-positioned strip: the strip would have had to hard-code the
bar's height, which changes with whether the order can be deleted, archived or
saved.

The wrap of the bar's existing children in `.ph-action-row` is load-bearing —
`.ph-btn` carries a bare `flex: 1`, which grows on the *vertical* axis once the
bar is a column.
