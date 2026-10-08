---
id: RS-207
title: Pack mode side panel can't be scrolled to its actions
type: bug
status: in-progress
priority: P2
created: 2026-10-08
reporter: jinhu
branch: fix/pack-side-panel-scroll
pr:
version:
related: []
---

## Ask

> I can only see part of this section and can not scroll down.

(With a screenshot of sell-order Pack mode: the side panel's selected-item card
and the **Finish packing** card, listing four lots "Counted short, not on the
order yet", with **Apply 4 counts to the order** cut off at the bottom of the
window while the list keeps going on the left.)

## Context

Pack mode's side panel (`.pk-side`, `apps/frontend/src/styles/desktop.css`) is
`position: sticky; top: 0` with no height cap. It holds the selected-item card
(a 4:3 photo box, part, From, warehouse, qty, count, serials or lots) and the
Finish card (the pre-v1.228.0 short list, the flagged list capped at 200px, the
apply hint, and up to three 48px buttons) — roughly 1000px, taller than an iPad
in landscape or a laptop window. A sticky box taller than its scroll container
stays pinned, so its bottom only comes into view once the whole list has been
scrolled to its end. **Apply** (v1.229.0), **Edit order** and **Mark shipped**
were out of reach while packing.

Box check (`.bc-side`, the PO bench view in the same full-width shell) has the
identical rule and a taller panel (340px column, uncapped serial and problem
lists), so it carried the same bug.

## Acceptance criteria

- [ ] In Pack mode at 1024px wide and up, the side panel is never taller than
      the window while it is pinned, and scrolls on its own: Apply, Edit order
      and Mark shipped can be reached without scrolling the list to its end.
- [ ] Box check's side panel (above 1100px) behaves the same way.
- [ ] Where the panel stacks under the list (Pack < 1024px, Box check
      ≤ 1100px) it flows with the page — no inner scroll box.
- [ ] Holds in compact density and in WebKit on an iPad-landscape viewport.

## Out of scope

- Pinning only the Finish actions: a sticky element can't leave its card, so
  it stays off screen while the card's top is, and pinning the panel by its
  bottom pushes the selected item's photo off the top instead.
- Shrinking the photo on short screens — saves ~56px, not enough on its own.

## Notes

- The cap is `calc(100dvh - 46px)`, not `100dvh`: the sticky area is inset by
  the focus page's padding (22px top, 24px bottom), so a `100dvh` panel would
  still end below the window.
- Box check is a sibling fix outside the literal ask — same shell, same rule.
