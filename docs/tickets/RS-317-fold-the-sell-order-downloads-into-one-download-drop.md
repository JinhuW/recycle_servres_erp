---
id: RS-317
title: Fold the sell order downloads into one Download dropdown
type: story
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: consolidate-downloads-dropdown
pr: "#779"
version: 1.293.0
related: []
---

## Ask

> move all these download in one button, you can have a dropdown.
>
> _(with a screenshot of the sell order page head showing three buttons side by side: `$ Price template (bid sheet)`, `Packing list`, `Packing list by PO`)_

## Context

The sell order page head carries three download buttons (`DownloadMenu` in
`apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`): the bid sheet
(v1.25.0), the packing list (its own file since v1.130.0) and the packing list
by PO (v1.189.0), plus a warehouse `<select>` that appears between them when
the order's packable lines span more than one warehouse (v1.220.2). Together
with Pack mode, Archive and Edit they overflow the head on a laptop and wrap
to a second row. Each button carries its explanation only as a hover title.

The dashboard's range chip (`DashboardRange.tsx`, `.dash-range-*`) is the
repo's existing popover-menu pattern: a chip with `aria-haspopup="menu"`, a
`role="menu"` popover closed by outside click or Escape, keyboard-reachable
rows.

## Acceptance criteria

- [x] The sell order page head shows one `Download` button with a chevron in
      place of the three download buttons and the warehouse select.
- [x] Clicking it opens a menu with three rows: Price template (bid sheet),
      Packing list, Packing list by PO. Each row shows its hint as a subline
      instead of only a hover title.
- [x] Picking a row closes the menu and downloads the same file, with the same
      query string and file name, as the old button did.
- [x] When the order's packable lines span more than one warehouse, the menu
      carries the warehouse picker under the two packing-list rows; it narrows
      both packing lists and never the bid sheet, as before.
- [x] The two packing-list rows are disabled with the "nothing to pack" hint
      when every line is at 0; the bid sheet row stays enabled.
- [x] The button is disabled while a file is being prepared.
- [x] The menu closes on outside click and on Escape, and Escape returns focus
      to the button.
- [x] Both locales have the new `Download` label.

## Out of scope

- Any change to the export routes or the files themselves.
- The mobile PWA, which has no sell order downloads.
- Folding Pack mode, Archive or Edit into the same menu: those are page
  actions, not downloads.

## Notes

- The warehouse picker lives inside the menu rather than beside the button so
  the head really is one button; it still only renders when there is a choice
  to make.
