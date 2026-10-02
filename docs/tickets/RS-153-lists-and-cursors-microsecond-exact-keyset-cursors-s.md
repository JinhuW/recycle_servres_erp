---
id: RS-153
title: "Lists and cursors: microsecond-exact keyset cursors, sell-order stats, every list walks its pages"
type: bug
status: done
priority: P2
created: 2026-10-02
reporter: jinhu
branch: fix/cursors-lists
pr: "#471"
version: 1.199.0
related: [RS-150, RS-151]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

This is Batch 8a of the approved plan,
`docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`, covering
review findings M18 and M37. Batch 8b is the frontend robustness items:
M34, M35, M36, M30 and M39.

## Context

- **M18:** six keyset lists encoded their cursor from a timestamp column that
  postgres.js parses into a JS Date (milliseconds only). The next page then
  skipped or repeated rows inside that millisecond. The transfer-orders list
  had the µs-exact pattern since v1.193.0.
- **M37:** four screens read only the API's first page: the phone PO list, the
  sell-order inbox (tiles included), internal transactions, and the phone
  Market (first 100, shown as 30). The desktop submit draft probe was not
  scoped to the user.

## Acceptance criteria

- [x] `lib/pagination.ts` gains `cursorTsSelect`, `cursorTs` (with a format
      check) and `cursorTsParam`. The PO list, sell orders, bank feed,
      internal transactions, web submissions and activity use them. A burst of
      rows inside one millisecond pages out exactly once each, newest first.
      A malformed cursor timestamp reads as page one.
- [x] `GET /api/sell-orders/stats` returns count and revenue per status, under
      the list's archive rule. The inbox tiles read it, falling back to the
      list for an older backend.
- [x] The phone PO list, the sell-order inbox and internal transactions walk
      every page with `forEachKeysetPage`.
- [x] The phone Market list shows the true total and has Load more. The
      desktop draft probe asks for `mine=true`.

## Out of scope

- Batch 8b.

## Notes

- The new test inserts its burst through `(${ts}::text)::timestamptz`. A bare
  `${ts}::timestamptz` parameter loses its microseconds on the way in too. The
  first version of the test did that and was really testing ties.
