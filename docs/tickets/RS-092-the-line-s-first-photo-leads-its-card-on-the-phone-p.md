---
id: RS-092
title: The line's first photo leads its card on the phone products screen
type: story
status: in-review
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/rs-092-line-photo-leads
pr:
version:
related: [RS-074]
---

## Ask

> move the image before the title.

(with a screenshot of the phone PO products screen — PO-1446, the "Micron
32GB DDR4" card — a red arrow drawn from the photo tile under the spec chips
up to the rank badge)

Asked which of three placements was meant — the photo *in* the rank slot,
*next to* the number, or the whole strip above the title — the answer was
**next to the number**.

## Context

Since RS-074 (v1.154.0) the phone PO products screen lists each line as a
card: rank badge, title and spec chips on the first row, then every photo
the line carries as a strip of 44px tiles (four, then `+n`), then the Qty ·
unit cost / total row. The photo is what a purchaser recognises the line by,
and it sat under the text, in a row of its own, so the eye read the card
top-down before reaching it.

## Acceptance criteria

- [ ] On `/purchase-orders/:id/products` a line with photos shows its first
      photo as a 44px tile between the rank badge and the title.
- [ ] A line with more than one photo keeps the strip under the chips for the
      rest, with the same four-then-`+n` fold (so `+n` now first appears at
      six photos).
- [ ] A line with no photo renders as before: badge, then title.
- [ ] Tapping the leading tile opens the lightbox and does not open the line
      editor.
- [ ] The capture flow's Review screen and the desktop PO page are unchanged.

## Out of scope

- The Review screen (`OrderReview.tsx`) — it never rendered photos.
- The line editor's own photo list (`SubmitForm.tsx`).

## Notes

The strip of every photo stays on purpose: the phone is where photos are
taken, so it is where they are checked (v1.154.0).
