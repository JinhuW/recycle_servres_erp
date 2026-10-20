---
id: RS-336
title: Account pool table: 10-row scroll and sortable columns
type: story
status: done
priority: P2
created: 2026-10-20
reporter: jinhu
branch: sortable-paginated-table-scroll
pr: 803
version: 1.306.0
related: []
---

## Ask

> Update this table to show 10 rows max and scroll for next page.
>
> Also all field can sort

(About the manager's Facebook Account Pool table, shown in a screenshot.)

## Context

The manager view of the account pool
(`apps/frontend/src/pages/desktop/FacebookAccountPool.tsx`) renders every
account in one long, unsorted list — the `<tbody>` is a plain `.map` over the
filtered `visible` array, with no pagination and no column sorting. With 14+
accounts the table runs off the bottom of the card, and the only ordering is
the natural `no` order from the snapshot.

The snapshot is already fully client-side, so both asks are frontend-only. The
"scroll for next page" ask was clarified with the requester: **scroll within
the table** (body capped to ~10 rows with a pinned header), not page-number
pagination. Sorting follows the existing click-to-sort header pattern in
`DesktopMarket.tsx` (`sortableTh`, `aria-sort`, `▲`/`▼`), done as a client-side
comparator here. Only the manager view changes; the purchaser rack and
"your accounts" cards are untouched.

## Acceptance criteria

- [ ] The manager account-pool table body shows ~10 rows, then scrolls
      vertically for the rest; the column header stays pinned while scrolling.
- [ ] Every data column header is clickable to sort: #, Account UID, Status,
      Holder, Password, 2FA code, Email, Email password, Recovery email,
      Cookie, Notes.
- [ ] Clicking a header sorts ascending; clicking it again reverses; the active
      column shows a `▲`/`▼` indicator and sets `aria-sort`.
- [ ] Search and the status filter still work and compose with the active sort.

## Out of scope

- Page-number pagination (Prev/Next, page sizes) — the requester chose scroll.
- Server-side sorting or any backend/API change.
- Sorting the purchaser's "your accounts" cards or the Import preview table.
- Persisting the chosen sort across reloads (kept as ephemeral local state, per
  the `DesktopMarket` precedent).

## Notes

Plan: `~/.claude/plans/clever-yawning-wadler.md`.
