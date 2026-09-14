---
id: RS-049
title: The desktop PO list stops at the newest 50 orders
type: bug
status: in-progress
priority: P2
created: 2026-09-14
reporter: Jinhu
branch: fix/po-table-pagination
pr:
version:
related: []
---

## Ask

> fix the bug that the current PO table can not show a limit amount without
> auto fetch more or loading more.

A screenshot of the desktop Purchase Orders list was attached.  Its stage
chips read Draft 3 · In Transit 4 · Reviewing 23 · Ready to Pay 4 · Done 16.

## Context

Those chips sum to exactly 50.  `GET /api/orders` has been keyset-paginated
(default `limit` 50, max 200, `nextCursor` in the response) since the API
gained cursor pagination, but the desktop list still makes one bare request
and reads only `orders`.  It never sends a limit and never follows the cursor,
so it silently shows the 50 newest POs and nothing older.  Every figure the
page derives client-side — the stage-chip counts, the KPI cards, search, the
twelve sortable columns, the Done prune — runs over that truncated slice, so
the org-wide numbers are wrong too.

Infinite scroll (the Activity and Payments pattern) is the wrong shape here:
those pages filter, sort and count on the server, whereas the PO list does all
of it in the browser, and a scroll-paged list would keep search and the chip
counts partial.  The fix follows every page the way the Shipping table does,
progressively — the first page renders at once, older pages append as they
land with a loading row at the foot.

## Acceptance criteria

- [ ] The desktop PO list shows every purchase order the caller may see, not
      the newest 50.
- [ ] Stage-chip counts and the KPI cards reflect the whole loaded scope.
- [ ] The first page appears immediately; a "loading older orders" row shows
      at the foot until the last page lands, then disappears.
- [ ] Changing a filter (category chip, archived toggle, role preview) while
      pages are still streaming never appends rows from the previous scope,
      and stops the previous stream's fetching.
- [ ] Returning from an order's edit page restores the list scroll position
      even when the order was beyond the first page.
- [ ] `en` and `zh` strings are in parity.

## Out of scope

- The mobile PO list (`pages/Orders.tsx`) and the desktop sell-order list
  (`DesktopSellOrders.tsx`) have the same silent 50-row cap — same fix shape,
  separate tickets.
- `DesktopShipping.tsx` carries its own inline page-following loop; it could
  adopt the new `lib/keysetPages.ts` helper, which also gives it a stop
  condition it lacks today.

## Notes

Plan reviewed before implementation.  The review added the stop condition
(a superseded stream must stop fetching, not just rendering — StrictMode
double-mounts in dev and every chip click would otherwise orphan up to seven
`limit=200` requests), first-page-replaces semantics, a flex wrapper for the
spinner, and gating the "no orders match" row on the full load.
