---
id: RS-388
title: Phone: the page no longer zooms in when a PO line field is focused
type: bug
status: done
priority: P2
created: 2026-10-24
reporter: jinhu
branch: JinhuW/auk
pr: 865
version: 1.332.1
related: [RS-252]
---

## Ask

> 修复一个手机端的问题：
>
> 目前在我们填写PO 的产品的时候总是容易自动放大整个页面。 我希望能固定大小，而不会自动缩放

## Context

iOS zooms the whole page in when you focus a text field whose computed font
size is under 16px. It doesn't zoom back out when you leave the field, so the
purchaser is left with a page wider than the screen and has to pinch it back.
All 15 fields of the phone shell's PO line form are 14px
(`.ph-field .input` / `.select` in `apps/frontend/src/styles/phone.css`), so
every tap on part number, qty, unit cost, sell price or serials set it off.
The desktop shell's base `.input` is 13.5px, so an iPad did the same.

The zoom was held back until v1.258.7 by `user-scalable=no` in the viewport
meta. RS-252 removed it because of the review finding FE-11 ("the phone can
zoom"), and that let the focus zoom through as well.

## Acceptance criteria

- [ ] On an iPhone, focusing any field of a PO line (part number, qty,
      condition, serials, unit cost, total, sell price) leaves the page at its
      normal scale. (To confirm on a real iPhone once dev deploys.)
- [x] The cap covers every phone-shell form and the desktop shell on an iPad.
      It goes on the page-wide viewport, not on each field's CSS.
- [x] Android's viewport isn't capped, so pinch zoom works there as before
      and FE-11 stays fixed. On iOS, Safari lets a pinch go past the cap.
- [x] Field sizes and the layout of the PO form are unchanged.

## Out of scope

- **A static `maximum-scale=1` in `index.html`.** It would also stop the zoom
  on iOS, but Android Chrome takes it as a pinch lock, and Android never
  focus-zooms. That would undo FE-11 for no gain.
- **Raising every field to 16px.** That is the other standard fix, but it
  changes how the whole phone shell looks. It also misses any field whose size
  is set inline, and the viewport cap covers all of them in one place.
- **Bringing back `user-scalable=no`.** That is the thing FE-11 removed.

## Notes

- `main.tsx` adds `maximum-scale=1` to the viewport before the first render,
  and only when the user agent is iOS: the UA names an iPhone, iPad or iPod,
  or it says Macintosh and the device has more than one touch point (iPadOS
  reports itself as a Mac).
- Verified in Playwright that the meta is capped for iPhone, iPad and
  iPadOS-as-Mac user agents, and left alone for a Mac without touch, a Pixel 7
  and desktop Chrome. The phone PO line form renders unchanged. Playwright
  can't reproduce the zoom itself, which is UIKit behaviour, so the zoom
  check is on a real iPhone. There is no iOS Simulator on the dev Mac.
- Unverified: whether the installed home-screen app on iOS honours the cap as
  a pinch lock, the way Safari doesn't.
