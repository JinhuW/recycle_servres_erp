# Test templates are built by `migrate.mjs` and only exist once complete

**2026-10-01.** RS-134. Two ways the test harness used to lie:

1. **Half-built templates were reused.** `ensureWorkerDb` set
   `templateReady = true` before doing any work, and later processes only
   checked whether `<worker>_tmpl` *existed*. A migration or the seed failing
   after `CREATE DATABASE` left a half-migrated or unseeded template behind.
   Every later file on that slot cloned it and failed in ways unrelated to its
   own change, most often a wall of 401s from a `users` table with no rows.
2. **Migrations ran bare.** Each file was replayed with a plain `unsafe()`:
   no transaction per file, no ledger, no lock timeout. A migration that can't
   run inside a transaction (e.g. `CREATE INDEX CONCURRENTLY`) passed the suite
   and then failed production boot, which runs every file through
   `scripts/migrate.mjs` inside `sql.begin`.

## Now

- The template is built as `<worker>_tmpl_building`. A stale one is dropped
  first. It is `ALTER DATABASE … RENAME`d to `<worker>_tmpl` only after migrate
  **and** the seed both succeed. `templateReady` is set only after that.
- Migrations run by spawning `scripts/migrate.mjs` with `DATABASE_URL` pointing
  at the building database, the same runner production boots with. The
  maintenance-DB advisory lock (key 778423) stays held across the whole spawn,
  because migration 0042 creates a *cluster-wide* role and `migrate.mjs`'s own
  lock is scoped to its target database.

## When a test fails with "migrate (template) failed"

That's a real migration error, and the message includes the runner's output.
Fix the migration. Don't work around it in the harness: production boot would
fail the same way.

Checked by hand by adding a `SELECT 1/0;` migration. The run fails with
"migrate (template) failed", no `_tmpl` is left behind, and the next run builds
cleanly once the file is removed.
