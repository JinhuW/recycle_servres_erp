---
id: RS-034
title: Refine the PO pages when the window gets small
type: story
status: done
priority: P2
created: 2026-09-09
reporter: Jinhu
branch: feat/po-narrow-desktop
pr: 291
version: 1.134.0
related: [RS-031, RS-032]
---

## Ask

> help me refine the PO page while the page get small

## Context

The desktop shell serves every window 720px and wider (narrower than that the
phone shell takes over). Neither purchase-order page had a single width rule:
the list's toolbar spilled out of its card once the window dropped under about
1100px, the KPI tiles jumped from 4-up to a 2×2 block that ate half of a short
window, and "PO-1371" wrapped onto two lines even at 1400px. The edit page
kept its fixed 280px side column at every width, so at 1000px the item table
had ~410px and showed two of its eight columns; the "Other fees" inputs ran
past the cost tape, the status stepper ran past its card, and the Order-details
grid pushed the Notes box out of the card. Under 900px the sidebar was simply
hidden, leaving the page with no way back to the list.

The shape of a small window is the same on a laptop with a side-by-side
browser, a split-screen tablet, or a manager checking a PO next to a
spreadsheet — the page has to work there, not just at full width.

## Acceptance criteria

- [ ] At 1000px and 800px the Purchase-orders toolbar (category filter, Show
      done / Show archived, search, Columns) wraps inside its card; nothing is
      clipped.
- [ ] Under 1100px the KPI tiles stay in one row as long as four fit at 150px,
      then wrap; the tiles are shorter so the table keeps its height.
- [ ] The order ID never wraps, at any width. Under 1100px it stays pinned at
      the left while the table scrolls sideways, and takes the row-hover
      colour with the rest of the row.
- [ ] Under 1100px the edit page is one column: items, then status/details/
      Save, then payment detail, ledger and activity.
- [ ] The item table scrolls inside its card instead of squeezing to two
      columns; the "Order details" title no longer breaks mid-word.
- [ ] On an editable PO under 1100px the Other-fees note and amount sit on
      their own line under the label; on a Done PO the printed value stays on
      the label line.
- [ ] Under 1100px the status stepper shows every stage as a numbered dot and
      names only the current one; hovering any dot shows its name.
- [ ] The Order-details fields go two-up under 1100px, and the Notes box sits
      inside the card at every width (this was broken at 1400px too).
- [ ] The footer (Shipping labels, Products, Total units, Total cost,
      Cancel/Save) wraps with Save reachable, and its labels don't break.
- [ ] Under 900px the sidebar becomes a 64px icon rail (icons, brand mark,
      avatar, sign-out) instead of disappearing; each icon shows its name on
      hover.
- [ ] At 1400px both PO pages look as they did, except the two fixes above
      (ID on one line, Notes inside the card).

## Out of scope

- The phone shell (under 720px) — it has its own PO screens.
- Other desktop pages between 900 and 1100px; only the shell rule under 900px
  changes for them (rail instead of no sidebar).
- Switching directly between two edit pages by editing the URL hash keeps the
  first order's lines on screen until a reload — seen while testing, separate
  ticket.

## Notes

- Plan: `~/.claude/plans/curious-discovering-clarke.md` (session-local).
- One breakpoint for the PO pages (1100px, where the 1080px orders table plus a
  240px sidebar stops fitting); the rail reuses the existing 900px shell query
  so untouched pages stay pixel-identical between 900 and 1100.
- No new unit tests: every change is CSS or a className, and the frontend
  suite has no DOM runner. Verified by screenshots at 1400/1200/1000/800/720.
