# New-PO Submit dropped edits to saved products

**2026-11-07, ERP v1.446.0 (RS-570).**

## Symptom

On the desktop new-PO page (`#/submit`), I opened a product that was already
saved, changed its Qty from 4 to 6 and clicked Submit. The screen and the
table showed 6 and the PO was created. The database row still said 4:

```sql
SELECT part_number, qty FROM order_lines WHERE order_id = 'PO-…';
-- DUPTEST-FAN-01 | 4
```

No error was raised and no warning was shown.

## Cause

A product on this page is "saved" (`_confirmed`) as soon as its Confirm
succeeds, or when adding the next product saves the one before it. After that:

- the drawer still lets every field be edited, but its Confirm is disabled
  (`LineDrawer.tsx`, `disabled={confirming || line._confirmed}`);
- `updateLine` only changed React state;
- `doSubmit` sent only `filter(l => !l._confirmed)` as `addLines`, plus meta.

So nothing ever carried an edit to a saved product to the server. The edit page
doesn't have this bug, because it marks edited lines `_dirty` and sends them as
`lines`. Neither does "add to an existing draft", which sends every product
from the screen.

## Fix

`_dirty` now lives on `Line` (`submit/line.ts`). `applyLinePatch` sets it when a
field of a saved product changes. Read "saved" off the line *before* the patch:
the save's own patch, `{ _confirmed, _dbId, no }`, carries the non-`_` key `no`.
Reading it after the patch would mark every product edited the moment it was
saved. `savedLineEdits` (`submit/editLine.ts`) turns those products into the
edit page's `editLineToPatch` shape, and Submit's PATCH sends them as
`lines: [{ id, … }]`, which the server already accepted on a Draft. Such a row
reads "Not saved" until Submit, and the unsaved-changes guard counts it.

## Lesson

**Check a save flow against the database row, not the screen.** The UI was
right in every way the browser could show. Only the `psql` read caught the bug.
When a verify run changes data, finish it with a query on the row.

## Verifying locally

The shared `recycle_erp_test` was behind `dev`'s migrations: `/api/orders` gave
500 on `order_commission_bank_linked`. The run used a throwaway database, as
[2026-10-23](2026-10-23-local-db-behind-dev-and-playwright-login-stuck.md)
describes. This worktree also had no root `.env`, so the backend got only
`DATABASE_URL` (from the main checkout's `.env`, not echoed) and `JWT_SECRET`.
Leaving out the tracker and fleet tokens also keeps a local backend from
reaching Facebook.
