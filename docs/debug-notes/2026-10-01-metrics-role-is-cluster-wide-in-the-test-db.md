# The `metrics` role is cluster-wide, so the shared test cluster carries one state for every worktree

**2026-10-01.** RS-130. Migration 0141 turns the `metrics` role into
NOLOGIN, because 0042 had created it with the password `metrics` on every
cluster, prod included.

## The trap

Each test worker clones its own *database*, but roles live on the *cluster*.
Every worktree points `TEST_DATABASE_URL` at the same Postgres on
`127.0.0.1:55432`. The first suite that replays 0141 makes `metrics` NOLOGIN
for the whole cluster. 0042 only creates the role `IF NOT EXISTS`, so no later
replay turns login back on.

A worktree still on the old `tests/metrics-role.test.ts`, which logs in as
`metrics`/`metrics` and reads `pg_stat_database`, then fails with an auth error
that has nothing to do with its own change.

## What to do

Rebase onto `origin/dev`. The current test asserts the role *cannot* log in.
Don't "fix" it by running `ALTER ROLE metrics LOGIN PASSWORD 'metrics'` on the
test cluster: that recreates the credential 0141 exists to remove.

The same applies to any future migration that touches a role, a tablespace or
another cluster-level object. Template clones don't isolate those. Expect peer
worktrees to see the change as soon as one suite runs.
