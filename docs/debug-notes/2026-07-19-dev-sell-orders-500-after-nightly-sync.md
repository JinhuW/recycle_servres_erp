# Dev sell-orders 500 every night: db-sync erases dev-only migrations

**Symptom.** `GET /api/sell-orders` on the dev backend returned 500
("Unhandled error") while every other page worked. Started overnight with no
deploy in between. Backend log showed only the request-log line; the dev
service has no `ERROR_LOG_DIR`, so the JSONL error sink was stdout-only and
Railway's log view surfaced just the `message` field.

## Root cause

The nightly db-sync (04:02 UTC) mirrors prod into dev with
`DROP SCHEMA public CASCADE` + restore of prod's dump. That makes dev's
schema *exactly* prod's — so any migration that exists only on dev
(here `0074_so_payment_received_by.sql`, the `sell_orders.payment_received_by`
column) is erased, and `schema_migrations` rolls back to prod's head (0072).

The backend only runs `migrate.mjs` at container start. It had been running
since 2026-07-16, so nothing re-applied 0073/0074 after the sync. The
sell-orders list query joins `users` on `so.payment_received_by` → column
does not exist → 500. On top of that, the running pool held cached plans
against dropped objects.

**Trap:** this is the same "dev migrations ahead of prod" trap as
[2026-07-16-db-sync-clean-drop-ordering](2026-07-16-db-sync-clean-drop-ordering.md),
one layer up. The schema-reset restore fixed the *sync*, but left the *dev
schema* prod-shaped until the next backend deploy. Any dev-only migration
breaks its feature's pages nightly, and it looks like a backend bug, not a
sync bug.

## Diagnosis path (for next time)

1. `railway logs` on dev backend → which route 500s.
2. `SELECT max(filename) FROM schema_migrations` on the **dev** DB vs
   `ls apps/backend/migrations | tail -1` on the deployed branch.
3. If the ledger is behind the code, the previous night's sync reset the
   schema and the backend hasn't restarted since.

## Fix (v1.17.5)

Immediate: redeploy the dev backend — boot re-runs `migrate.mjs`, which
re-applies the dev-only migrations onto the freshly mirrored schema.

Durable: `sync.sh` now ends every successful restore by redeploying the
backend via the Railway API (`serviceInstanceRedeploy`), so the nightly
order is always mirror → migrate → fresh pool. Needs on the db-sync
service: `RAILWAY_PROJECT_TOKEN` (project token, dev environment, named
`db-sync-backend-redeploy`) and `BACKEND_SERVICE_ID`. A missing var aborts
*before* the restore; a failed redeploy fails the run loudly.
