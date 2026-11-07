# WS-A2 — Seller kinds in the task queue

Make the fleet task queue carry seller tasks without changing anything a
search worker sees. CONTRACTS §4 is the spec.

## Owns

- `apps/backend/src/fleet/claim.ts`, `fleet/sql.ts`, `fleet/scheduler.ts` (lease expiry only), `fleet/seller.ts`.
- One migration replacing `fleet_fence_pool_owner` (CONTRACTS §4.5).
- Tests: `apps/backend/tests/fleet-seller-*.test.ts`.

## Do

1. `taskRows`: `LEFT JOIN fleet_cities`; select `payload`. `handed()` returns the seller shape of `HandedTask` for seller kinds; `why()` copes with no city.
2. `pickTask`: the kind filter from CONTRACTS §4.1. Read the worker's version from `fleet_workers.version` for this `worker_id`; use `fleetVersionAtLeast` against `FLEET_SELLER_MIN_WORKER_VERSION`. Budget: seller kinds are not stopped by the budget gate. Familiar-city ordering untouched for search.
3. `claim`: a `role = 'seller'` slot is claimable only by a worker at or above the minimum, mirroring the cloak check.
4. `minutesTodaySql`: exclude seller kinds from both halves of the union.
5. `releaseTasks`, the trigger migration and the scheduler's expiry: CONTRACTS §4.5's table. `notifyReady` skips null items.
6. `enqueueSellerTask(tx, accountNo, kind, ref, payload, dueAt)`: insert with `ON CONFLICT DO NOTHING` on the seller open index; return the task id or null. `pg_notify('fleet_tasks', '')` like the scheduler does.
7. `POST /worker/seller/report` and `POST /worker/seller/screenshot` per CONTRACTS §4.4, mounted on the `worker` Hono app so `/api/fleet/worker/seller/*` is CSRF-exempt and bearer-authed. Store each report as a `fleet_task_events` row (`kind: 'seller_report'`) and call `applySellerReport` in the same transaction. Confirm the body-size limit the Cloudflare Worker (`deploy/cloudflare/worker.js`) and Hono allow; set 512 KB or record the real ceiling in CONTRACTS via the orchestrator.
8. Fleet analytics: every query that counts searches already filters `kind = 'search'`; grep `fleet/` and `routes/fleet.ts` for any that doesn't (task lists, Recent activity, `FleetTasksTab` data) and make them tolerate null city/item.

## Exit criteria

- [ ] Tests: a seller task is never handed to a search slot, to another account's seller slot, or to a worker below the minimum version; a search task is never handed to a seller slot.
- [ ] Tests: a leased `msg-send` becomes `uncertain` on each of the three paths (release, pool fence, expiry); `inbox-sync` follows the table.
- [ ] Tests: a report from a worker whose epoch moved on is stored and answered 200 `{ accepted: … }`; a malformed body is 422; nothing answers 401/409 for epoch reasons.
- [ ] Tests: seller minutes don't count toward the budget; a budget-exhausted seller slot still gets its seller tasks.
- [ ] Every existing fleet test passes unedited.
- [ ] Version bump, CHANGELOG, README Status.
