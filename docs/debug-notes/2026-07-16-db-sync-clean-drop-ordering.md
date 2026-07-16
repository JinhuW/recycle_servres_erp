# db-sync: pg_dump --clean breaks when dev has schema objects prod lacks

**Symptom.** The nightly prod→dev sync cron (`deploy/railway-sync`) failed
every run since ~2026-07-13 with:

```
ERROR:  cannot drop constraint users_pkey on table public.users because other objects depend on it
DETAIL:  constraint sell_orders_payment_received_by_fkey on table public.sell_orders depends on index public.users_pkey
```

Dev silently stopped mirroring prod (the `--single-transaction` restore rolls
back, so dev just stays stale — nothing pages).

## Root cause

`pg_dump --clean` emits DROP statements ordered by the **source** (prod)
dependency graph. Migration `0074_so_payment_received_by.sql` had landed on
dev but not prod, so dev carried an FK
(`sell_orders_payment_received_by_fkey` → `users_pkey`) that prod's dump knew
nothing about. The dump dropped `users_pkey` before that FK → dependency
error → whole transaction aborted.

**Trap:** this recurs any time dev's migrations are ahead of prod — which is
the *normal* state of the dev→main→prod flow. Any new dev-only FK/index/view
on a shared object breaks `--clean`.

## Fix (v1.17.3)

`sync.sh` no longer uses `--clean`. It prepends
`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;` to the plain
dump inside the same `psql --single-transaction` run:

- dev-only objects can't break drop ordering (the whole schema goes at once);
- a failed restore still rolls back to an **unchanged** dev, not an empty one;
- `pgcrypto` (lives in `public`, dropped by the CASCADE) is recreated by the
  dump's `CREATE EXTENSION`.

Verified locally against `postgres:16-alpine` (same image as the cron): old
pipeline reproduces the exact error; new pipeline mirrors, recreates
pgcrypto, and a mid-restore failure leaves dev's tables intact.

## Where to look next time

The failure is only visible in the **dev environment** logs of the `db-sync`
service (Railway → recycle-erp-experiment → db-sync, env `dev`). The cron run
shows FAILED but nothing alerts on it.
