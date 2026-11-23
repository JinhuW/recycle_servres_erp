# A PL/pgSQL FOR loop reads its rows lazily: `::text` in the query doesn't freeze them

**2026-11-23, ERP v1.475.0.**

## Symptom

`migrate.mjs --reset` failed with `syntax error at or near "149516"` once the
database held a routine whose SQL-standard body (`BEGIN ATOMIC … END` or
`RETURN …`) calls another routine. The reset's drop loop built
`DROP ROUTINE IF EXISTS <sig> CASCADE` from `p.oid::regprocedure`.

## Cause

A SQL-standard body records a dependency on what it calls, so dropping the
callee with CASCADE drops the caller too. The loop's row for the caller was
still to come, and `regprocedure` renders an OID that no longer exists as the
bare number, so the next statement was `DROP ROUTINE IF EXISTS 149516 CASCADE`.

The first fix, casting to text inside the loop's query
(`p.oid::regprocedure::text`), changed nothing: a PL/pgSQL `FOR r IN <query>`
runs the query through a cursor and fetches rows in batches as the loop goes,
so the cast is evaluated after the earlier iterations' drops.

## Fix

Materialise the list before the first drop:
`FOREACH sig IN ARRAY ARRAY(SELECT p.oid::regprocedure::text …)`. The
`ARRAY(…)` subquery runs to completion up front; a routine already gone by its
turn is a no-op under `IF EXISTS`. `tests/migration-ledger.test.ts` creates a
dependent pair before its `--reset` run.

## Rule

Any PL/pgSQL loop that drops or alters objects its own query lists must read
the whole list first (`ARRAY(…)`, or a temp table), not iterate a live query.
