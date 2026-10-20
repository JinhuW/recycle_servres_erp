---
id: RS-327
title: Cap the Fleet workers table at 15 rows and scroll the rest
type: story
status: done
priority: P2
created: 2026-10-20
reporter: jinhu
branch: feat/fleet-table-cap
pr: "#792"
version: 1.300.0
related: []
---

## Ask

> set up an max hight of this table.
>
> [Image #1]
> The max show is 15 of them, user can scroll it

## Context

Image #1 was the Monitors ▸ Facebook ▸ Fleet tab with 12 workers. The workers
table (`pages/desktop/FleetWorkers.tsx` → `WorkersCard`, `.fp-table-wrap`) has
no height limit, so it gets one row taller with every worker. The Recent
activity aside beside it takes the card's height (`.ff-split` in
`styles/facebookPool.css`), so it grows with the table.

The repo already caps a table this way. `.sub-lines-scroll` in
`styles/desktop.css` sets a `max-height` of the header plus a per-row budget,
scrolls the overflow, and pins the `thead th`.

## Acceptance criteria

- [x] With more than 15 workers, the table shows 15 standard rows and
      scrolls the rest inside the card.
- [x] The column headers stay pinned while the rows scroll, and still sort.
- [x] The "Fleet as of …" footer stays under the scroll area.
- [x] With 15 or fewer workers, the table looks the same as before.
- [x] The Recent activity aside still matches the card's height.

## Out of scope

- The Reddit tracker page (`DesktopTracker.tsx`). It reuses the
  `ff-workers` / `ff-table` classes but wasn't part of the ask, so the cap
  applies only to the Facebook table.
- An exact count of 15 rows measured in JS. The cap is a per-row height
  budget, like `.sub-lines-scroll`. Taller rows (a three-line status note, an
  open city fold) use more of the budget, so fewer of them fit.

## Notes

- The screenshot isn't committed because it shows the fleet's Facebook login
  emails.
- I measured the row heights against the local ERP, with Playwright serving a
  mocked 20-worker `/api/coordinator/fleet`. A two-line row is 55.3px, a row
  with a status note is 68.8px, and the header is 34.4px. The cap is
  `calc(35px + 55.5px * 15)`.
- `border-collapse` leaves the header's bottom border behind when the header
  sticks. The pinned `th` drops that border and draws an inset shadow, which
  moves with it.
