# The local backend suite crawls, then fails broadly, when the Docker VM is starved

**2026-09-19.** `pnpm --filter recycle-erp-backend test` normally finishes in
~15 s. This night one *file* took 959 s, then the full suite took 8053 s and
reported 269 failures across 90 files — none of them in code the branch
touched. The failure classes were the tell: `Hook timed out in 30000ms`,
`login failed … 500 {"error":"Internal error"}`, `Test timed out in 15000ms`,
and two `duplicate key value violates unique constraint
"pg_database_datname_index"`. That is a suite whose database is answering in
seconds per statement, not a suite with a bug in it.

## What it looked like from the outside

- Request log lines inside the test output showed `POST /api/auth/login …
  "ms":637` and `POST /api/orders … "ms":9191` — ordinary handlers taking
  seconds.
- A single test in `orders-company-pay-txn.test.ts` was reported at
  950 935 ms against a 15 s timeout: the process was not getting scheduled
  at all for long stretches.
- Nothing on the host was busy (`top` idle, 58 % memory free, 205 GB disk
  free) and the test DB's data dir had 831 GB free.

## The cause

`docker stats` on the Docker Desktop VM, not the host:

```
recycle-erp-testdb                        405%   … 122MB / 118GB block IO
supabase_studio_order_management          255%
realtime-dev.supabase_realtime_…          155%
storage_imgproxy_order_management         113%
```

and `pg_stat_activity` inside `recycle-erp-testdb` showed every worker's
`CREATE DATABASE … TEMPLATE` / `DROP DATABASE` in `IO: VersionFileSync` and
`IO: WALSync` — waiting on fsync. The Docker VM had been up 23 h with an
unrelated project's Supabase stack burning several cores, and the template
clone that `resetDb()` does per test (a `CREATE DATABASE`, which fsyncs the
whole new directory) is exactly the operation that collapses first when the
VM's virtual disk is contended. Each of the eight vitest forks does one per
test, so the suite turns into thousands of slow fsyncs and the 15 s test
timeout fires everywhere.

## How to recognise it in under a minute

1. `docker stats --no-stream` — any container other than the test DB above
   ~100 % CPU, or the test DB itself far above 100 %, on a suite that should
   be idle-cheap.
2. `docker exec recycle-erp-testdb psql -U <user from TEST_DATABASE_URL> -d
   postgres -c "select state, wait_event_type, wait_event, left(query,60)
   from pg_stat_activity where backend_type='client backend'"` — rows in
   `IO / VersionFileSync` or `IO / WALSync` on `CREATE DATABASE` / `DROP
   DATABASE`.
3. The failure list is timeouts and login 500s spread across unrelated
   files, not assertions.

If all three hold, the suite result says nothing about the branch.

## What to do

- Don't chase the failures in the code. Don't rerun the suite hoping — a
  second run here took 8000 s.
- Free the VM: stop or pause the containers that are not this repo's
  (`docker pause <name>` is reversible), or restart Docker Desktop. Ask
  before touching another project's containers.
- If the VM cannot be freed, push the branch and let CI's `backend-tests`
  job be the verification — it runs the same suite against a fresh
  `postgres:16` service container and is what gates the merge anyway. Say
  so in the PR / ticket rather than reporting the local run.
- Frontend tests and `pnpm -r typecheck` don't touch the DB and stay
  trustworthy; run those locally regardless.
