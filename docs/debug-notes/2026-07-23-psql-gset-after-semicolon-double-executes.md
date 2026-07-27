# psql `\gset` after a semicolon-terminated query double-executes the query

**Date:** 2026-07-23
**Area:** DB ops / one-off SQL scripts (psql)
**Severity:** low (harmless here, but silently mutating on a side-effecting query)

## Symptom

Ran a one-off transaction to clone `PO-1339` into a new PO. The allocation step was:

```sql
UPDATE id_counters SET value = value + 1 WHERE name = 'PO'
RETURNING ('PO-' || value) AS new_id;
\gset
```

psql printed the `RETURNING` result table (`PO-1352`), then **two** `UPDATE 1`
lines, and `\echo :new_id` reported `PO-1353`. The counter advanced by **2** and
the intended value `PO-1352` was skipped (no order ever created with that id).
The final row was correct (`PO-1353`), just one counter number was burned.

## Root cause

A statement terminated with `;` executes and displays immediately. A following
`\gset` on its own then re-sends the **same query buffer**, executing the
`UPDATE` a **second time**. For a plain `SELECT` this is invisible; for a
**side-effecting** statement (here, an `UPDATE ... RETURNING` on a counter) it
runs the mutation twice.

## Fix / rule

When capturing a query result with `\gset`, terminate the query with `\gset`
itself — **not** with a `;`:

```sql
-- correct: no trailing semicolon; \gset both terminates and runs the query once
UPDATE id_counters SET value = value + 1 WHERE name = 'PO'
RETURNING ('PO-' || value) AS new_id
\gset
\echo :new_id
```

Never pair a trailing `;` with `\gset`, especially on INSERT/UPDATE/DELETE
`... RETURNING`.

## Notes

- Impact was cosmetic: `id_counters` is allowed to have gaps (like a sequence);
  the skipped `PO-1352` simply doesn't exist. No data corruption.
- If you must have a gapless counter for a script, allocate the id in code or
  verify the counter delta after running.
