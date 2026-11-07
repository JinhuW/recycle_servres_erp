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

- [x] Tests: a seller task is never handed to a search slot, to another account's seller slot, or to a worker below the minimum version; a search task is never handed to a seller slot.
- [x] Tests: a leased `msg-send` becomes `uncertain` on each of the three paths (release, pool fence, expiry); `inbox-sync` follows the table.
- [x] Tests: a report from a worker whose epoch moved on is stored and answered 200 `{ accepted: … }`; a malformed body is 422; nothing answers 401/409 for epoch reasons.
- [x] Tests: seller minutes don't count toward the budget; a budget-exhausted seller slot still gets its seller tasks.
- [x] Every existing fleet test passes unedited.
- [x] Version bump, CHANGELOG, README Status.

## Outcome

Migration `0233_fleet_seller_fence.sql`, v1.438.0. Tests:
`apps/backend/tests/fleet-seller-queue.test.ts`. Notes for the workstreams after A2:

- **Body limit.** The routes enforce 512 KB themselves. Above them, Hono's
  global JSON cap is 1 MiB (`index.ts`), and the Cloudflare Worker
  (`deploy/cloudflare/worker.js`) streams the body through, so the edge ceiling
  is the plan's 100 MB. The 1 MiB cap applies to the multipart screenshot too.
- **Report auth.** The token's HMAC and expiry only (a bad token is still 401).
  The task must be the token's account's, of the kind and ref the report names,
  and have a `handed` event for the token's worker id; otherwise the answer is
  200 `{ accepted: false, detail }`. The pool account's status and the slot's
  epoch are not read.
- **Idempotency.** A second report with the same outcome for the same
  `(account_no, kind, ref)` gets the first answer back and does not call
  `applySellerReport` again. A different outcome is applied (C decides what it
  means). The event's `detail` is `{ report, answer, epoch }`.
- **Screenshot key.** `uploadAttachment` adds a UUID, so the key is
  `fb-seller/screenshots/<account>/<uuid>-<task>-<step>.<ext>`: no overwrite on
  a retry. A task that is not the worker's answers 200 `{ ok: false, detail }`;
  a storage failure 502 `{ ok: false, detail }`.
- **Uncertain tasks** keep `worker_id`, `epoch`, `leased_at` and get `done_at`;
  each path writes a `released` (or `expired`) event whose detail says
  `state: 'uncertain'` / `uncertain: true`. A released `inbox-sync` keeps its
  account and wakes polls with `pg_notify('fleet_tasks', '')`.
- **Pick.** A seller slot reads its worker's `fleet_workers.version` (claim or
  heartbeat). Over budget, it is offered only its seller kinds; with nothing
  due it answers `nothing_due` and holds the poll, so an enqueue wakes it.
- **Left as they are.** `FleetTask.city` / `.item` stay typed `string` in
  shared, though seller rows carry null; the backend task lists and the city log
  already tolerate it in SQL, but a page that renders a seller task needs the
  shared type widened (a DTO change: E and the orchestrator). The `fleet_minutes`
  view still counts seller minutes (only the budget excludes them). The hourly
  purge does not delete `uncertain` tasks.
