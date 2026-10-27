# WS-A · Backend core: schema, auth scopes, cities, scheduler

**Depends on:** nothing. **Unblocks:** everything (merge the schema PR first,
early). **Owns:** `apps/backend/migrations/0205_fleet.sql`,
`apps/backend/src/fleet/{sql,auth,scheduler,tasks,cities}.ts`,
`apps/backend/src/routes/fleet.ts` (mount + manager routes for cities, items,
settings, tasks, round, city-log), `apps/backend/scripts/fleet-import.mjs`,
`packages/shared/src/fleet.ts` (first version), tests
`apps/backend/tests/fleet-*.test.ts`.

## Deliver in two PRs

### PR A1 — schema and skeleton (small, merge fast)

1. `0205_fleet.sql` exactly as `CONTRACTS.md` §4. Check the number is free
   against `origin/dev` at merge time.
2. `packages/shared/src/fleet.ts` with the types in §9.
3. `src/fleet/auth.ts`: three Hono middlewares — `managerOnly` (reuse the
   existing manager guard from `routes/coordinator.ts`), `hostAuth` (sha256 of
   the bearer vs `fleet_hosts.token_hash`, sets `c.var.host`), `workerAuth`
   (HMAC token per §3, loads the slot, `409 stale_epoch` on mismatch, sets
   `c.var.worker`).
4. `routes/fleet.ts` mounted at `/api/fleet` in `src/index.ts` (follow how
   `facebookPool` is mounted), with `GET /api/fleet/health` → `{ok, tables}`.
5. `docs/DATABASE.md`: a *Fleet* section listing the tables.
6. Tests: migration applies on the test DB; each scope rejects the wrong
   token; a worker token with a stale epoch gets 409.
7. Root version minor bump + `CHANGELOG.md` section ("groundwork, no
   behaviour").

### PR A2 — cities, items, settings, scheduler, import

1. `src/fleet/cities.ts` + routes (§7): list with each city's open task per
   item; create → `enabled=false` and a `verify-slug` task (`kind
   verify-slug`, `priority 50`); `PUT` incl. `override_verify`; `DELETE` →
   `disabled_at`, cancel open tasks. Items and settings `GET/PUT` with
   validation of §8 keys and bounds (copy the shape of
   `rs_console/settings.py` limits).
2. `src/fleet/scheduler.ts`:
   - `reconcile(sql, now)`:
     1. for every enabled city × enabled item with no open `search` task:
        insert one, `due_at = max(now, last_done_at + DAY / per_day)` where
        `per_day = city.per_day ?? settings.per_day_default`; reason
        `cadence` (or `added` when the city has no done task yet);
     2. cancel open tasks whose city or item is disabled;
     3. `expired`: leased tasks past `lease_expires_at`, or past
        `leased_at + task_max_minutes`; event `expired`; a new ready task
        for the pair with `due_at = now` (step 1 does it);
     4. probe: for each slot with `quarantined_until > now` and no probe task
        in `quarantine_probe_hours`, insert a `probe` task on the slot's
        first home city (or the most overdue city) for the first item;
     5. `NOTIFY fleet_tasks` if anything became ready.
   - Idempotent; safe to run from two backend instances (every insert goes
     through the partial unique index; catch `23505`).
   - Wired in `server.ts`: `setInterval(reconcile, 30_000)` guarded by
     `FLEET_ROLE !== 'manager-only'`; also called after every manager write.
3. `src/fleet/tasks.ts`: manual task, round start, task list, city log
   (tasks with events), used by routes.
4. `scripts/fleet-import.mjs --master <path>`: parses `master.toml`
   (`@iarna/toml` or `smol-toml`; add as a backend dep), upserts regions'
   cities (slug, name, radius, region) as `enabled=true, verified_at=now,
   verified_as='imported'`, the two items with phrases and filters, and the
   `search` settings. Dry-run flag prints the diff.
5. Tests (`fleet-scheduler.test.ts`, `fleet-cities.test.ts`): one open task
   per pair; add → due now and disabled until verified; override → enabled;
   delete → cancelled; expiry and `task_max_minutes`; probe cadence; import
   against the real `trackers/facebook/configs/master.toml` gives 127 cities
   and 2 items; two concurrent `reconcile` calls do not duplicate.
6. `docs/FEATURES.md`: nothing yet (no UI); say so in the PR.

## Exit

- [x] A1 merged (#875, v1.336.0, `0206_fleet.sql`): `GET /api/fleet/health` lists the
      tables on a local backend; dev follows the release.
- [x] A2 merged (#880, v1.338.0): after `fleet-import.mjs`, `GET /api/fleet/tasks?state=ready`
      returns 254 tasks; `POST /api/fleet/cities` creates a disabled city with
      a `verify-slug` task; `DELETE` cancels. Proven on a local backend against a
      scratch database (254 ready tasks 5 s after the import, on the scheduler's
      first tick) and in `tests/fleet-scheduler.test.ts` / `tests/fleet-cities.test.ts`.

## Notes for the agent

- Raw SQL with the `postgres` client, as the rest of `apps/backend`; look at
  `routes/facebookPool.ts` for the house style (comments say why, not what).
- `fleet_minutes` is a view; budget checks in WS-B read it.
- Do not add Playwright to the backend: slug verification is a worker task
  (WS-C runs it, WS-B closes it by setting `verified_at`/`verified_as`).
