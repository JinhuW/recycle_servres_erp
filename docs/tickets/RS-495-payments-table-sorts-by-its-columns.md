---
id: RS-495
title: Payments table sorts by its columns
type: story
status: done
priority: P2
created: 2026-11-01
reporter: jinhu
branch: JinhuW/naga-2
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1048
version: 1.401.0
related: []
---

## Ask

> It should sort for the table.

(Sent with a screenshot of the Accounting → Payments table, the header row
Date / Source / Payee / Amount / Owner / Status outlined.)

## Context

The Payments table headers were static. The list behind them,
`GET /api/bank-transactions` (`apps/backend/src/routes/bankTx.ts`), is
keyset-paged on `(posted_at, id)` and loaded by infinite scroll, so a
client-side sort would only reorder the rows already fetched. The sort has to
run in SQL, with the cursor on the active column, the way
`routes/orders/list.ts` already does it.

## Acceptance criteria

- [x] Clicking Date, Source, Payee, Amount, Owner or Status sorts the whole
      filtered list, not just the loaded rows: desc, then asc, then default.
- [x] Scrolling to load more under any sort neither skips nor repeats rows.
- [x] The default order is unchanged (newest first).
- [x] The chosen sort is remembered across navigation, like the page's filters.
- [x] An unknown `sort` answers 400; a cursor that doesn't fit the sort falls
      back to page one.

## Out of scope

The mobile payments view; multi-column sort.

## Notes

- Amount sorts by size (`abs(amount)`), so the default money-out lens puts the
  biggest payment first on a descending click rather than the smallest.
- Status sorts by the verdict the cell shows: sell order, PO, internal
  transaction, transfer, ignored, open.
