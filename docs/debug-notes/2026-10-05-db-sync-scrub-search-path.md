# db-sync fails every night at the scrub: pg_dump empties search_path

**Symptom.** Dev's data stopped moving after 2026-10-02. The `db-sync` cron
service in Railway's `dev` environment still ran at 04:00 UTC and its
deployment showed SUCCESS. Its log ended:

    [sync] 2026-10-03T04:04:30Z  prod(thomas.proxy.rlwy.net:41763) -> dev(postgres.railway.internal:5432)
    ERROR:  relation "refresh_tokens" does not exist

That line was preceded by ~60 `drop cascades to table …` NOTICEs from the
schema reset. There was no `[sync] done` line. It failed the same way on
2026-10-03, -04 and -05. The 2026-10-02 run, the last one before
`scrub.sql` existed, ended `[sync] backend redeploy triggered` /
`[sync] done`.

## Root cause

`sync.sh` restores in a single psql session:

    DROP SCHEMA public CASCADE; CREATE SCHEMA public;   -- preamble
    <plain-format pg_dump of prod>
    <scrub.sql>                                          -- added v1.196.1

Every plain-format `pg_dump` opens with

    SELECT pg_catalog.set_config('search_path', '', false);

so that its own DDL can't be hijacked by a planted object. The dump never
resets it, so it holds for the **rest of the session**. That includes
whatever is appended after the dump. The dump itself qualifies every name
(`public.orders`), but `scrub.sql` said `TRUNCATE refresh_tokens`. With no
schema on the path, that name resolves to nothing.

`--single-transaction` + `ON_ERROR_STOP=1` rolled the whole restore back
each time. That was the right failure mode: dev stayed intact, just stale.
Nobody noticed for three nights because nothing alerts on a failed cron run.

**Why CI missed it.** `tests/sync-scrub.test.ts` ran the scrub against the
migrated test schema with the connection's default `search_path`
(`"$user", public`). It proved the TRUNCATE had no FK in its way, but not that
the file resolves its names in the session it really runs in.

## Fix (v1.211.1)

- `scrub.sql` schema-qualifies every name (`public.refresh_tokens`, …).
- The test runs `SELECT pg_catalog.set_config('search_path', '', true)` in
  the same transaction before the scrub. That is the session state the dump
  leaves behind. An unqualified name added later fails CI.

## Diagnosis path (for next time)

1. Logs are per deployment, and the CLI only lists the newest 20. The cron
   run lives in whichever deployment was **active at 04:00 UTC**, which isn't
   necessarily the newest:

       railway deployment list --environment dev --service db-sync --json
       railway logs --environment dev --service db-sync --lines 400 --json <deploymentId>

   For older ids, query the GraphQL `deployments(first: 60, input: {serviceId, environmentId})`.
   Filter out the `drop cascades` NOTICEs, or the real line is buried.
2. Reproduce in the sync image itself, not with the laptop's `pg_dump` (14):

       docker run -d --name sync-repro-pg -e POSTGRES_PASSWORD=x postgres:18-alpine
       # pg_dump a migrated DB → pipe preamble + dump + scrub.sql into
       # psql --single-transaction --set ON_ERROR_STOP=1 <scratch db>

   Dumping the local `recycle_erp` (at migration head) via
   `host.docker.internal:5432` covers the full schema without prod
   credentials.

## Trap

Anything appended to the restore after the dump runs with an empty
`search_path`. A future addition must qualify its names, or reset the path
itself: a seed row, a `GRANT`, an `ALTER ROLE`. Functions called without
`pg_catalog.` still resolve, because `pg_catalog` is always searched
implicitly. Tables, sequences and user-defined functions do not.

Related: [2026-07-16-db-sync-clean-drop-ordering](2026-07-16-db-sync-clean-drop-ordering.md),
[2026-07-19-dev-sell-orders-500-after-nightly-sync](2026-07-19-dev-sell-orders-500-after-nightly-sync.md).
