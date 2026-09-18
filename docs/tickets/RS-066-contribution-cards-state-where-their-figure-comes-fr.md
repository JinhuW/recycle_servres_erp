---
id: RS-066
title: Contribution cards state where their figure comes from
type: task
status: in-review
priority: P3
created: 2026-09-17
reporter: jinhu
branch: chore/contrib-card-notes
pr:
version: 1.149.2
related: [RS-059, RS-061]
---

## Ask

With a screenshot of the three dashboard contribution cards (Cost $416,731 ·
80 purchase orders; Sell orders $447,466 · 13 sell orders; Profit $183,859 ·
13 sell orders):

> also make a note to the title for these card.
> to exlain how these data comes from.

The screenshot was pasted inline and is not on disk.

## Context

The three cards (RS-059, v1.146.0) carry a title, a total and a count, and
nothing that says what the total is: the Cost card counts every PO past
Draft while the leaderboard next to it counts only reviewed ones (RS-061),
and the Sell orders and Profit cards are realized figures for a manager
but projections for a purchaser.  A reader has to know the definitions to
trust the numbers.  Each card now says, under its title, what it sums.

Wording, agreed with Jinhu (manager lens): Cost — "Purchase orders past
Draft, by order date — goods plus other fees."  Sell orders — "Revenue of
Done sell orders, by their last update."  Profit — "Sell price minus PO
cost and fees on what sold, Done sell orders by their last update."  The
purchaser lens says "Your purchase orders…" and "Projected revenue /
profit … on your reviewed orders' lines".  "Last update" rather than "the
date they closed" because the window is `sell_orders.updated_at`, which a
later note edit also moves.

## Acceptance criteria

- [x] Each contribution card shows a one-line note under its title that
      states what the figure sums; the same text is the title's tooltip.
- [x] The note differs by lens: realized wording for managers, "your …" /
      "projected …" wording for purchasers and role preview.
- [x] `en` and `zh` in parity.
- [x] No definition changes.

## Out of scope

- Notes on the KPI tiles or the Category breakdown card.

## Notes

- `ticket.sh` allocated RS-065, which a sibling session also took (PR #349); renumbered RS-066. RS-063 and RS-064 were taken by sibling
  sessions between planning and writing.
