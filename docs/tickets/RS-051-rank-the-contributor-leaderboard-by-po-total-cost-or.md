---
id: RS-051
title: Rank the contributor leaderboard by PO total cost or commission
type: story
status: in_progress
priority: P2
created: 2026-09-14
reporter: Jinhu
branch: feat/leaderboard-po-cost
pr:
version:
related: []
---

## Ask

> udpate the Contributor leaderboard in dashboard is po total cost based.

Then, on the first plan:

> let we add an option, sort by commission or by total cost they paid.

## Context

The dashboard's contributor leaderboard (`GET /api/dashboard`,
routes/dashboard.ts) has ranked purchasers by projected gross profit since
v1.0.1 — the margin set on the lines of their Ready-to-Pay/Done POs in the
selected range — and its "Entries" column counts lines, not orders.  The
request is a switch between two rankings: by what each purchaser bought (the
total cost of their purchase orders) and by the commission they earned on it.

"Total cost" here is the figure the PO pages already show — goods
(`orders.total_cost`, or the line goods subtotal when the header is NULL) plus
`other_fees`.  Commission is the board's existing projected figure.  Because a
purchaser only receives their own row's money, the ranking is computed on the
server and the choice travels as a query parameter like `range`; it is not a
saved preference.  Window, lifecycle filter (Ready to Pay and Done),
purchaser-only board and the PRD §6.8 masking are unchanged.

## Acceptance criteria

- [x] Leaderboard rows carry `cost` = Σ over the purchaser's POs in range of
      (goods total + other fees).
- [x] `GET /api/dashboard?lb=cost` (the default) orders rows by `cost` DESC;
      `?lb=commission` orders by `commission` DESC; anything else falls back
      to cost, as an unknown `range` falls back to 30d.
- [x] `count` is the number of POs, not lines; the desktop header reads
      "Orders".
- [x] The desktop card has a two-way control, Total cost / Commission, and its
      subtitle names the active ranking; a "Total cost" column sits right after
      "Orders".
- [x] Mobile has the same control above the leaderboard card; "Top
      contributors" shows the active metric as its headline number and a real
      PO count in its caption; the purchaser "Your rank" card follows the
      chosen ranking and no longer prints a "behind by" gap it cannot compute.
- [x] A purchaser still sees `cost: null` on every row but their own.
- [x] `en` and `zh` strings are in parity.

## Out of scope

- Including Draft / In Transit POs in the board — the "counts from Ready to
  Pay" rule (v1.132.0) stays.
- Excluding archived POs from the dashboard — no dashboard query filters
  `archived_at` today; a separate ticket if wanted.
- The category segmented control on the desktop card is still a label-only
  no-op (documented in the component).
- Persisting the ranking choice as a user preference — `range` is not
  persisted either; revisit if the toggle turns out to be flipped every visit.

## Notes

- The ticket script handed out RS-050, which a sibling session had already
  taken minutes earlier; renumbered by hand.
- The mobile "behind by $X" line under "Your rank" was removed rather than
  ported: the card only renders for purchasers, and the backend masks every
  peer row's money for them, so the gap was never computable — it subtracted
  a masked `null` and printed a negative dollar figure.
