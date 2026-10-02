---
id: RS-158
title: Phone PO products screen lands at the bottom after a scan, with a top/bottom jump button
type: story
status: in-progress
priority: P2
created: 2026-10-02
reporter: jinhu
branch: feat/scan-scroll-bottom
pr:
version:
related: [RS-074]
---

## Ask

> [Image #1]
>
> This page should already scroll to the buttom, when user no first time enter the page. I meant after user scan an ram, it will go back to this page.
> or use click some link to this page we call it first time.
>
> when user keep scaning, then we should alwasy scroll to the buttom. also add a buttom to go to top or go to buttom.

## Context

The phone PO's products screen is `/purchase-orders/:id/products`. It is
`OrderDetail` with `section === 'products'`, the screen RS-074 split out of the
PO page. The line form opens only from that screen. While a capture is on
screen, `MobileApp` early-returns `Camera`/`SubmitForm` and drops
`detailOrder`, so `OrderDetail` unmounts. It mounts again, fresh, once the
form is saved, backed out of or cancelled. The screen therefore reopened at
the top after every line. The dock comment there said so: "the screen reopens
at the top after each line". A purchaser scanning RAM stick after stick
scrolled down to the newest line each time.

Decided with the requester:

- The page is the existing PO's Products screen, not the new-PO Review screen.
  The screenshot didn't come through.
- After editing an existing line, the screen lands on that line, not at the
  bottom.

## Acceptance criteria

- [x] Opening Products from the PO page's link (or a deep link) shows the top
      of the list.
- [x] After adding a line through the line form (saved, backed out or
      cancelled), the screen reopens at the bottom. The newest line is fully
      visible above the dock and the jump button. Every following scan does the
      same.
- [x] After editing an existing line, the screen reopens with that line in
      view.
- [x] When the list overflows, one round button floats above the dock. It
      shows ↓ (to the bottom) until the list is at the bottom, then ↑ (to the
      top). No button shows when the list fits.
- [x] The landing is one-shot. After a scan-return, going back to the PO page
      and reopening Products via its link shows the top.

## Out of scope

- The new-PO Review screen (capture flow). It has the same remount, but the
  requester picked the Products screen.
- The desktop PO page.

## Notes

Plan: `~/.claude/plans/swift-toasting-phoenix.md`.

- **Where the landing is recorded.** It is set where the form opens
  (`openOrderLineForm`), not in each way back. Save, Back, cancel and rescan
  all return through the products path, so one entry point covers them all.
- **Back or cancel from an add.** Both also land at the bottom, because the
  user was in the middle of scanning.
- **One toggle button, not an ↑/↓ pair.** The ask names one button. A single
  slot needs only one button's clearance above the dock, and the target never
  shifts under a second tap.
