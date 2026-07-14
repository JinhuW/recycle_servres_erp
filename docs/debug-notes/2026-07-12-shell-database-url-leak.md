# Shell-exported DATABASE_URL leaks into db:migrate and tests

**Symptom.** `pnpm db:migrate` (or `tests/part-number-canon.test.ts`) dies at
connect with:

```
PostgresError: unrecognized configuration parameter "schema"  (FATAL, 42704)
```

**Cause.** The interactive shell (zsh profile) exports a Prisma-style URL for
a *different* project:

```
DATABASE_URL=postgresql://ram_user:changeme@localhost:5432/ram_inventory?schema=public
```

`apps/backend/scripts/load-env.mjs` (correctly) does **not** override
variables already present in the environment, so the repo-root `.env` value
loses. postgres.js forwards the `?schema=` query param as a startup GUC,
which Postgres rejects — hence the misleading error. Everything that connects
via `process.env.DATABASE_URL` is affected: `db:migrate`, `db:seed`, `pnpm
dev`, and the one test file that connects directly instead of through
`tests/helpers/db.ts` (`part-number-canon.test.ts`).

**Fix / workaround.** Prefix the command with the repo URL (or unset the var):

```
DATABASE_URL='postgres://recycle:recycle@127.0.0.1:55432/recycle_erp_test' pnpm db:migrate
```

**Tripwire for future sessions.** If any DB command in this repo fails with
`unrecognized configuration parameter "schema"`, it is NOT a code or
migration bug — check `echo $DATABASE_URL` first. The local dev/test Postgres
is the `recycle-erp-testdb` container on `127.0.0.1:55432` (see `.env`).
