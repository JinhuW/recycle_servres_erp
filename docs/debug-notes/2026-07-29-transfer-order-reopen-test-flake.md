# `transfer-orders.test.ts` flakes on the "mere Draft sell order" cases

**Date:** 2026-07-29
**Status:** diagnosed, not fixed — the *product* code is correct, the test picks its fixture badly.

## Symptom

Two tests in `apps/backend/tests/transfer-orders.test.ts` fail intermittently
(roughly 1 run in 5, on unmodified `dev`):

- `POST /api/inventory/transfer-orders/:id/reopen > reopens despite a line sitting on a mere Draft sell order`
- `DELETE /api/inventory/transfer-orders/:id — discard > discards despite a line sitting on a mere Draft sell order`

Both fail as `expected 409 to be 200`. Re-running the same file with the same
code passes. **Do not bisect a source change against this** — a single
pass/fail comparison looks like causation and isn't. Run the file 5–6 times
before concluding anything.

## Cause

The tests build their fixture by picking *the first* of something:

- `transferOne()` takes the first `Reviewing`/`Done` line from `GET /api/inventory`
  (`ORDER BY l.created_at DESC`).
- `attachSellOrder()` takes the first sell order (`ORDER BY created_at LIMIT 1`)
  and flips it to `Draft`.

Neither checks that the picked line is *otherwise unclaimed*. In the seeded
data ~14 `Reviewing`/`Done` lines are already attached to a **committed**
sell order (`Shipped` / `Awaiting payment` / `Done`), and seeded timestamps are
generated relative to the seed run's wall clock — so which line lands first
varies from run to run.

When the picked line happens to be one of those, it ends up on two sell orders
at once and the guard correctly refuses:

```
{"error":"cannot re-open: line(s) 489a8e43-… have moved on since receipt"}
lines=[{"id":"489a8e43-…","status":"Done","so_status":"Shipped"},
       {"id":"489a8e43-…","status":"Done","so_status":"Draft"}]
```

`committedSellStatuses()` counts the pre-existing `Shipped` link, `sell_count > 0`,
409. The Draft the test attached is irrelevant — the line was never free.

## Fix when someone picks this up

Make the fixture pick a line with **no** `sell_order_lines` row, e.g. filter
in `transferOne()` (or assert it) instead of trusting `find()` order. A
tiebreaker on the inventory `ORDER BY` does not fix it — the ordering is
stable within a run; the fixture's assumption ("first line is unclaimed") is
what's wrong.
