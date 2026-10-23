---
id: RS-367
title: Worker page: a full-height History column that tracks everything
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/rasbora
pr: 844
version: 1.321.0
related: []
---

## Ask

> [Image #1]
> This whole section can be used as history tracking

The image is the worker page for ca-2b. A red box marks its right edge,
running from the top of the worker card down past the History box under it.

## Context

Since RS-365 / RS-366 (v1.319.0, v1.320.0) the worker page knows which
accounts a worker used, with their proxy, and the fleet console can serve the
worker's login ledger. But the page's History was a 286px box under the card,
beside Open checkpoints. It held only status changes (the fleet document keeps
7 days), the latest search, listing and backup, and open checkpoints. Above it,
the card ran the full width with its values in the left third, so the strip
the requester boxed was empty.

## Acceptance criteria

- [x] At 1190px and wider the worker page is two columns; History runs beside the card from its top to the bottom of the main column, and scrolls its own list.
- [x] History merges, newest first: status changes, checkpoints, search/listing/backup, account sign-on and leave (with outcome), and every login on this worker tagged with its account.
- [x] Identical consecutive logins fold into one line with a count and range.
- [x] Against a console without `/v1/logins`, the column shows the rest and a one-line note.
- [x] Below 1190px (the page's existing breakpoint) the column stacks under the main column.

## Out of scope

- Status changes older than the fleet document's 7 days (the coordinator
  keeps 30; the console asks for 7).
- Filters on the column.

## Notes

- ERP-only. Logins come from the console's `/v1/logins` (RS-366), which is
  not deployed yet; until it is, the column shows everything else.
