---
id: RS-182
title: Nightly prod-to-dev DB copy fails at the credential scrub
type: bug
status: done
priority: P1
created: 2026-10-05
reporter: jinhu
branch: fix/db-sync-scrub-search-path
pr: "#510"
version: 1.211.1
related: []
---

## Ask

> fix the DB copy up from prod DB to dev railway DB workflow.

## Context

The `db-sync` cron service in Railway's `dev` environment copies prod into dev
at 04:00 UTC (`deploy/railway-sync/sync.sh`). It dumps prod, then restores in
one psql transaction: drop and recreate `public`, the dump, then
`scrub.sql`, which clears prod's live credentials from the copy.

The last run that worked was 2026-10-02 04:01 UTC, before the scrub existed.
Every run since has logged

    ERROR:  relation "refresh_tokens" does not exist

and rolled back (2026-10-03, -04, -05), so dev was intact but frozen at
2026-10-02, and nothing alerted.

Plain-format `pg_dump` opens with
`SELECT pg_catalog.set_config('search_path', '', false);`, which holds for
the rest of the psql session. The scrub runs in that session after the dump,
and its table names were unqualified. `tests/sync-scrub.test.ts` ran the scrub
with the default `search_path`, so CI could not see it.

## Acceptance criteria

- [x] `scrub.sql` resolves every name with `search_path` empty.
- [x] `tests/sync-scrub.test.ts` runs the scrub with `search_path` emptied, so
      an unqualified name fails CI.
- [x] The sync's restore block, run in `postgres:18-alpine` against a dump of
      the fully migrated schema, commits and leaves no tokens behind.
- [x] The next nightly run on Railway logs `[sync] done` and redeploys the dev
      backend.

## Out of scope

- Alerting when the cron run fails. No alert channel is configured
  (`ALERT_WEBHOOK_URL` is unset on the prod uptime monitor too).
- Watch paths on `db-sync`, which rebuilds on every dev push.

## Notes

Reproduced in the sync image before the fix: same error, psql exit 3. See
`docs/debug-notes/2026-10-05-db-sync-scrub-search-path.md`.

Verified 2026-10-08: the 04:03 UTC run on Railway (`db-sync`, dev) logged
`[sync] done` and `backend redeploy triggered`, no `ERROR` lines.
