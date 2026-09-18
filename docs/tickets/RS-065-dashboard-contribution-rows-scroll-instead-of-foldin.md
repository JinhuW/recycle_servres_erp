---
id: RS-065
title: Dashboard contribution rows scroll instead of folding
type: story
status: in-progress
priority: P3
created: 2026-09-17
reporter: jinhu
branch: feat/contrib-scroll
pr:
version:
related: [RS-059, RS-061]
---

## Ask

With a screenshot of the Cost card's Purchaser tab, the row list outlined
in red (seven purchasers and a "Remaining 1 purchasers" row):

> this part should be able to scrollable.

## Context

The three contribution cards on the desktop dashboard (Cost, Sell orders,
Profit; RS-059) show the top seven rows of the chosen dimension and fold
everything after them into one "Remaining n …" row. The fold is done by
the server: `services/contributions.ts` slices at seven and returns the
tail as an aggregate, so the card cannot show an eighth contributor even
if it wanted to — in the screenshot the eighth purchaser is a number with
no name.

The fix is to send every row, largest first, and let the list scroll
inside the card past a fixed height, the way the contributor leaderboard
already does. The cap keeps the three cards level: a card with up to
eight rows looks exactly as it does today, and only a longer list gains a
scrollbar, with the column header pinned.

## Acceptance criteria

- [ ] `GET /api/dashboard` returns every contributor row for each
      dimension, sorted by amount, with no `others` aggregate; the rows
      still sum to the metric's total.
- [ ] A card tab with more than eight rows scrolls inside the card; the
      card does not grow and the header stays visible while scrolling.
- [ ] A tab with eight rows or fewer shows no scrollbar and the card's
      height is unchanged from before.
- [ ] No "Remaining n …" row is rendered in either language.

## Out of scope

- The phone dashboard (it has no contribution cards).
- The contributor leaderboard, which already scrolls.

## Notes

The server fold had to go: a client cannot scroll rows it never receives.
The five `contribRemaining*` strings are removed with it.
