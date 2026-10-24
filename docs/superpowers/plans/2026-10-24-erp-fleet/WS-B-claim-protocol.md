# WS-B · Claim protocol: slots, hosts, workers

**Depends on:** WS-A PR A1 (schema, auth). **Unblocks:** integration.
**Owns:** `apps/backend/src/fleet/{claim,hosts,workers,vnc}.ts`, the
`/api/fleet/worker/*`, `/api/fleet/hosts/*`, `/api/fleet/slots*`,
`/api/fleet/workers`, `/api/fleet/releases` routes, `apps/backend/scripts/fleet-seed-slots.mjs`,
tests `apps/backend/tests/fleet-claim.test.ts`, `fleet-hosts.test.ts`.

## Tasks

1. **Slots seed** (`fleet-seed-slots.mjs`): one `fleet_slots` row per
   `fb_pool_accounts` row with status `fleet`; `proxy_url` from the latest
   open `fb_worker_accounts` stint (sealed with `FB_POOL_KEY` once the login
   is added by hand), `home_cities` from a JSON the operator passes (exported
   from the coordinator's `/v1/fleet`), `device` from a JSON exported from the
   coordinator's `device_profiles` (WS-F provides both files). Dry-run flag.
2. **`claim.ts`** (`CONTRACTS.md` §5): the pick order; `epoch + 1`; unseal
   password/TOTP/cookies/token with `poolKey(env)`; open an
   `fb_worker_accounts` stint exactly as `routes/facebookPool.ts` `/assign`
   does (reuse its helper, do not copy it); mint the worker token. All in one
   transaction with `SELECT … FOR UPDATE SKIP LOCKED` on `fleet_slots`.
3. **`heartbeat`**: renew slot lease; HEALTHY renews the leased task;
   parked states release it (event `released`, `reason: state`); DEGRADED no
   change; record `fleet_workers` row (state, version, vnc_port,
   last_heartbeat_at). Answer `directives` (empty for now; `relogin` later).
4. **`next-task`**: as §5. Implement the hold with `LISTEN fleet_tasks` on a
   dedicated connection (`postgres` client `sql.listen`), one in-process
   `EventEmitter` fanning out to waiting requests; cap concurrent holds at 200
   and answer `null` immediately past that. Budget from `fleet_minutes`.
   `verify-slug` tasks go to any healthy worker; `probe` tasks only to their
   quarantined slot.
5. **`events`**: append `fleet_task_events`; a `finished`/`stopped` on a
   `verify-slug` task sets `fleet_cities.verified_at/verified_as` from
   `detail.location` and `enabled = (detail.matches === true)`.
6. **`session`**: reseal cookies/token into the pool row, `cookie_at = now()`.
7. **Hosts** (`hosts.ts`, §6): create host (token shown once, store sha256),
   `desired` (count = `capacity` when authoritative else 0; image/version
   from the active release or `FLEET_IMAGE_WORKER`; vnc ports assigned
   `5901+`; `roll.replace` chosen as §6 says), `report` (store, update
   `last_seen_at`, `version`), releases (`POST /api/fleet/releases` starts a
   roll: walk hosts, replace one idle worker at a time, gate on the
   replacement's first HEALTHY heartbeat; port the rules from
   `trackers/facebook/rs_coordinator/rs_coordinator/fleet.py` `advance_rollout`).
8. **Slots and workers routes** (§7): list, release quarantine, park (sets a
   parked state and releases).
9. **VNC relay** (`vnc.ts`): `GET /api/fleet/worker/vnc` upgrades a worker's
   WebSocket and registers it by `worker_id`; the manager side reuses
   `src/vncBridge.ts` to bridge the noVNC page to that socket. Keep the
   existing coordinator VNC path working.
10. **Tests:** two concurrent claims never return the same slot; a stale
    epoch on heartbeat/next-task/events/session → 409; lease expiry frees the
    slot and the scheduler returns its task; a `next-task` hold wakes within
    1 s of `POST /api/fleet/tasks`; parked heartbeat releases the task,
    DEGRADED does not; budget exhaustion answers `budget`; `verify-slug`
    result enables or leaves the city disabled; `desired` honours
    `authoritative=false`; a roll replaces one worker at a time.
11. Root version minor bump, changelog, `docs/DATABASE.md` if columns change.

## Exit

- [x] `apps/backend/scripts/fleet-fake-worker.mjs` (ship it in this PR, it is
      the integration tool): claims a slot on dev, long-polls, receives a task
      within 1 s of a manual task, reports done, receives the next one; a
      second run with the same account gets a different slot or `no_slot`.
      (2026-10-24, against a local backend on a private database with a
      made-up pool account: both manual tasks arrived 5–6 ms after their
      insert + `NOTIFY`; the second run exited 75 `no_slot`. Against dev:
      WS-F's integration step, once A2's `POST /api/fleet/tasks` exists.)
- [x] Hosts tab data (`GET /api/fleet/hosts`) shows a fake host's report
      (2026-10-24, same local run: `report.containers`, `version`,
      `last_seen_at` and `desired` in the answer).

## Notes for the agent

- Never log unsealed secrets. The claim answer is the only place they leave
  the database.
- The old coordinator's heartbeat renewed leases forever; here
  `task_max_minutes` (WS-A scheduler) is the cap. Do not add another.
- `familiar`: the account searched the city within `familiar_days`, read from
  `fleet_tasks` done by this `account_no`.
