---
id: RS-102
title: The sell-order picker lists every open order, not just those in the newest 200
type: bug
status: done
priority: P2
created: 2026-09-24
reporter: jinhu
branch: fix/so-picker-all-pages
pr: "#398"
version: 1.175.1
related: [RS-100]
---

## Ask

> code-review dev -> main. fix all issue and release to prod.

## Context

Found by the pre-release review of v1.174.0–v1.175.0. The Inventory "Add to
sell order" picker (RS-100) read one page of `GET /api/sell-orders?limit=200`.
That page is the newest 200 non-archived orders of *every* status. The picker
then kept only the open ones on the client. Past 200 orders, an older Draft,
Shipped or Awaiting-payment order was missing from the picker, and nothing said
so.

## Acceptance criteria

- [x] The picker follows `nextCursor` until the list is exhausted, so every
      open, non-archived sell order can be picked.
- [x] The first page renders before the rest arrive; closing the dialog stops
      the fetching.

## Out of scope

A server-side "open only" filter. The list endpoint takes one `status`, and
paging is enough at this volume.
