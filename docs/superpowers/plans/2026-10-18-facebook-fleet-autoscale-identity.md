# Facebook fleet: auto-scaling, rolling upgrades, permanent device identity

## Context

The Facebook Marketplace fleet runs 10 hand-copied worker containers on the homelab VM `10.10.10.73`. The workers are the `deploy/docker-compose.homelab*.yml` files, one service each.

- **Scaling is manual.** A new worker takes a copied compose file, a hand-written `secrets.homelab-<x>.env`, a proxy variable, and three console env lists.
- **Upgrades reach one worker.** `scripts/deploy.sh` rebuilds `aimm-recycle:latest` but only recreates `rs-monitor`. The other 9 run whatever image they were last started from.
- **A worker's session lives only on its host's disk.** It is `configs/sessions/<id>/fb_state.json`. Losing the VM means logging in again. The coordinator keeps an encrypted copy in `session_snapshots`, but nothing ever restores it: `GET /v1/session/{id}/restore` has no client.
- **There is no device identity.**
  - The browser profile is throwaway.
  - The viewport, locale and timezone are Playwright defaults, and capture uses a different viewport than the monitor.
  - Continuity comes only from the user agent in the sidecar and Facebook's `datr`/`sb` cookies.
- **An account swap leaks the old device.** The ERP's *Assign to fleet* (`apps/backend/src/routes/facebookPool.ts` `/:no/assign`) rewrites a slot's vault account in place with another Facebook login. The forced re-login keeps `DEVICE_COOKIES = ("datr","sb")` (`facebook.py:1553-1567`), so the new login inherits the previous login's device. That links accounts for bans.

**Goal.** The fleet scales itself to the accounts that are ready and rolls new versions out safely. No worker has to log in again because it was recreated, upgraded or moved. Each Facebook account keeps one device id forever, recorded in the DB, even on a new worker or VM. The coordinator and the workers never take each other down.

**Decisions (from the user).**
- Workers run on Docker hosts. An agent on each host does the reconciling, and a new VM is just another host running that agent.
- One worker per ready account.
- Rolling, health-gated upgrades.
- The device id belongs to the **Facebook account**, not the worker slot.
- A second VM joins over the **homelab LAN**: the coordinator and a private registry are published on `10.10.10.73`.

## Ticket (drafted here; written as implementation step 1)

`scripts/ticket.sh new "Facebook fleet scales itself, rolls new versions, and keeps every account's session and device" --type story --priority P2` (RS-292; filed as RS-290 and renumbered)

**Ask**

> Enable the facebook has the abilities auto scale the worker and update the version of theri workers. But make sure it can keep the session information persistence withot re-login.
>
>
> alwasy keep the same device id without change it, event create a new vm / worker. it should reuse the device id that it used before. A DB can also introduce to tracking this type of information

> No matter the coordinator or the worker it shoud run dependent. either break won't impact each other.

**Acceptance criteria**

- [ ] Every Facebook account has one `device_profiles` row:
  - a `device_id`, user agent, screen, viewport, locale, timezone and the sealed `datr`/`sb`;
  - created once and never regenerated;
  - applied to the browser by whichever worker or host runs that account.
- [ ] Two Facebook logins never share a device. A swap in the ERP quarantines the old session and applies the new login's own device cookies.
- [ ] A worker whose `/data` is missing or older than the coordinator's snapshot restores the session, but only one recorded for the same account. It does not log in again.
- [ ] Turning on a slot that is ready (`fleet_enabled`, region and proxy set) starts a worker on a host with capacity, with no compose file or hand-written env. Turning it off stops the container and keeps its `/data`.
- [ ] `rsc fleet release <ver>` upgrades workers one at a time.
  - The next worker waits until the current one heartbeats on the new version in a state no worse than before.
  - On a timeout, that worker goes back to its previous image and the rollout halts. Everyone else keeps running.
- [ ] Each failure is harmless to the other side:
  - **Coordinator or Postgres down:** workers keep searching and boot from their local cache, and the agent changes nothing.
  - **Agent down:** workers keep running.
  - **A worker crash-loops:** the coordinator is unaffected.
- [ ] A second VM on the LAN joins with the `rs-fleetd` compose file and a host token.

**Out of scope:** creating VMs automatically. Moving a slot to another host automatically: moves are started by an operator, to prevent split brain. ERP UI for fleet control: it goes through the CLI and the console. A persistent Chromium `user_data_dir`.

## Design

```
ERP ─> rs_console ─> rs_coordinator (FastAPI, Railway PG)  <── LAN 10.10.10.73:8500 ──┐
                       device_profiles · session_snapshots · fleet_* · worker_configs  │
                       background tick: reconcile assignments + advance rollout        │
        host A: rs-fleetd ─docker─> rs-worker-<id> (monitor) ── heartbeat/identity ────┘
        host B: rs-fleetd ─docker─> rs-worker-<id>     (images from LAN registry :5000)
```

- The coordinator never touches containers. The agent only reconciles containers against a desired state it caches.
- Workers cache their identity, session and config in `/data`.
- The coordinator, the console and the messenger stay on compose.

### Identity model

What each thing belongs to:
- **The Facebook account** owns the device: `device_profiles` is keyed by `identity_key = "uid:<fb uid>"`, falling back to `login:<lower(fb_username)>`.
- **The slot** owns the session and the egress IP. The slot is the vault `accounts` row, whose `worker_id` (e.g. `va-1`) is stable. Its proxy is in its config.

How that plays out:
- The session follows the slot from host to host, because the proxy moves with it.
- A login moved to another slot signs in fresh, as `/assign` already does, but carries its own `datr`/`sb`. Facebook sees the same trusted device signing in from a new place.
- Slots without a proxy (`denver-1`) get `pin_host` set.

**Seeding.** Existing workers are seeded from what they present today: the sidecar user agent, 1280x720, and the container's timezone. Nothing Facebook can see changes. New accounts get a profile from a short curated list, with the timezone taken from the region.

**The Chrome version tracks the browser.** The user agent's Chrome major version follows the real browser after an image upgrade, so `Sec-CH-UA` doesn't contradict it. The platform and OS part never changes.

### Data model

Changes go in `rs_coordinator/rs_coordinator/db.py` `SCHEMA` and are mirrored in `pg.py`.

New tables:
- **`device_profiles`:** `identity_key PK`, `device_id UNIQUE` (uuid4), `fb_uid`, `platform`, `user_agent`, `screen_w/h`, `viewport_w/h`, `device_scale_factor`, `locale`, `timezone_id`, `device_cookies_blob` (vault-sealed, set once from the first backup that has `datr`), `source` (seeded or generated), `created_at`, `updated_at`.
- **`fleet_hosts`:** `host_id PK`, `capacity`, `cordoned`, `vnc_host`, `agent_version`, `last_seen_at`, `last_report_json`.
- **`fleet_assignments`:**
  - Columns: `worker_id PK`, `host_id`, `state` (run or stopped), `image`, `previous_image`, `spec_generation`, `move_to_host`, `observed_image`, `observed_running`, `observed_at`, `vnc_target`.
  - A stopped row keeps its host, so placement is sticky.
- **`fleet_releases`:** `id`, `version`, `image`, `state` (rolling, paused, done, failed or superseded), `current_worker`, `current_started_at`, `current_pre_state`, `failed_worker`, `failure`, `skipped_json`, `created_by`, `created_at`, `finished_at`.
- **`worker_configs`:** `worker_id PK`, `toml`, `sha256`, `updated_at`.

New columns, added through the existing `_migrate_columns` / `WORKER_HEALTH_COLUMNS` pattern:
- `accounts`: `fb_uid`, `fleet_enabled DEFAULT 0` (ships dark), `pin_host`.
- `workers`: `host_id`, `retired_at`. The liveness sweep in `health.py` skips retired workers.
- `session_snapshots`: `identity_key`.

Add the five new tables to `TABLES` in `tests/test_postgres.py:44`. `test_the_two_backends_expose_the_same_api` then enforces that both backends have the same methods.

### Coordinator endpoints

**Worker routes** (`require_worker`; the token's id must match the path):

- **`POST /v1/workers/{id}/identity`**
  - Body: `{observed:{user_agent, viewport, screen, timezone_id, locale}}`.
  - Gets or creates the profile for the slot's current identity, idempotently (`ON CONFLICT DO NOTHING` followed by a SELECT).
  - Returns `{identity_key, device_profile, device_cookies|null, session:{identity_key, fb_user_id, backed_up_at}|null}`.
  - Returns 404 when the slot has no account.
- **`PATCH /v1/workers/{id}/identity` `{user_agent}`:** only the Chrome version token may change; anything else gets a 409.
- **`GET /v1/session/{id}/restore`** (existing): also returns `identity_key`. Returns **409** if the snapshot belongs to a different identity. Update the docstring: the egress IP is the proxy, which moves with the slot.
- **`POST /v1/session/backup`** (existing):
  - stamps `identity_key`;
  - captures `datr`/`sb` into the profile once;
  - re-keys a `login:` profile to `uid:` when `c_user` shows up.
- **Heartbeat:** `HeartbeatRequest` gets an optional `host_id`. `WorkerOut` also returns `host_id`, so the console can show it.

**Host routes:** a new `deps.require_host` checks `tokens.mint_host_token`. That is a domain-separated HMAC, so a worker token never passes as a host token and a host token never passes as a worker token.

- **`GET /v1/fleet/hosts/{host}/desired`:**
  - Returns `{generation, authoritative, release, workers:[{worker_id, image, spec_generation, config_sha256, env:{RS_WORKER_ID, RS_CONTROL_PLANE_TOKEN (minted), RS_HOST_ID}}]}`.
  - This retires the hand-written `secrets.homelab-*.env` files.
- **`GET /v1/fleet/configs/{worker_id}`:** returns the TOML with an ETag. Returns 403 unless the worker is assigned to the calling host.
- **`POST /v1/fleet/hosts/{host}/report`:** the containers the host actually runs.

**Admin routes** (`require_admin`; the ERP contract is unchanged):

- `GET /v1/fleet/state`
- `POST /v1/fleet/releases`
- `POST /v1/fleet/releases/{id}/{pause|resume|abort}`
- `PUT /v1/fleet/hosts/{id}`
- `POST /v1/fleet/workers/{id}/move` with `{host_id, force}`
- `PUT /v1/fleet/configs/{worker_id}` (the console publishes configs through this)

The CLI gets `rsc fleet add-host|hosts|state|enable|disable|release|pause|resume|abort|move` (`cli.py`), plus `rsc mint-host-token`.

New files:
- `routers/identity.py`
- `routers/fleet.py`
- `fleet.py` (pure logic)
- `device_profiles.py` (generation, the region→timezone table moved here from `rs_console/fleet.py` `REGION_TIMEZONES`, rewriting the user agent's version)

The tick is wired into `background.py` `Background.tick`.

### Coordinator logic (`fleet.py`)

**Reconciling assignments.**
- Each ready slot gets an assignment.
- A slot with no `worker_id` has one allocated once and stored. It must be safe for `WORKER_ID_PATTERN`, with no `.` or `@`; existing ids are kept.
- **Placement order:** `pin_host`, then a stopped row's previous host, then the live, non-cordoned host with the most free capacity.
- A slot that stops being ready → assignment `stopped`, and `workers.retired_at` is set.

**Advancing a rollout.**
- **One worker at a time.** The next worker is one whose image differs from the release and whose host was seen in the last 2 minutes. Hosts that weren't are skipped and listed in `skipped_json`.
- **Gate.** The gate passes when a heartbeat arrives after `current_started_at`, the version starts with `release.version`, and `gate_ok(pre, post)` holds:
  - **HEALTHY before:** must be HEALTHY after.
  - **Parked before** (challenge, `SESSION_EXPIRED`): must not be DEAD after.
  - **DOWN before:** always passes.
- **On a 20-minute timeout:**
  - the image goes back to `previous_image`;
  - the release is marked `failed` and Telegram ops gets an alert;
  - everyone else is untouched.
- **A newer release** supersedes the current one.

**Moves.** A move sets `move_to_host`. The worker is dropped from the old host's desired state. The assignment flips only when the old host's report shows the container gone, or at once with `force`, which is the operator saying the old host is dead.

### Monitor patches

The patches go on the vendored `ai-marketplace-monitor`, branch `recycle-patches`, starting from pin `9ef0fd2`.

`control_plane.py`
- Generalize `_post` into `_request`.
- Add `get_identity`, `update_user_agent` and `restore_session`.
- Like every call in that module, they never raise and return None on failure. Each has a 5-second timeout.

New `identity.py` (stdlib only), with `ensure_local_identity(mp)`:
1. Read `/data/identity.json`.
2. Ask the coordinator. If the coordinator doesn't answer, fall back to the cache, then to today's behaviour.
3. **The identity has changed:** rename `fb_state.json` to `fb_state.json.<hash>.<ts>.bak` and replace the device cookies.
4. **The file is missing, or its `saved_at` is older than the snapshot's** (and the snapshot is for the same identity): restore it with an atomic write of the file and the sidecar.
5. Write `identity.json` atomically.

`marketplace.py`
- **`create_page`:**
  - pass `viewport`, `screen`, `device_scale_factor`, `locale` and `timezone_id` from the profile;
  - take the user agent from the profile, falling back to `get_session_user_agent`, with the Chrome major version rewritten to `browser.version`;
  - call `context.add_cookies(device_cookies)` when the jar has no `datr`.
- **`save_storage_state`:** stamp `saved_at` and `identity_key` into the `.meta.json` sidecar.

`facebook.py`
- Call `ensure_local_identity` at the start of `login()`, and again in `_arm_relogin`, because `/assign` queues a re-login.
- In `_drop_session_cookies`, keep `DEVICE_COOKIES` only when the identity is unchanged.
- In `_send_heartbeat`, add `host_id` from `RS_HOST_ID`.

Container files
- **`docker/supervisord.conf`:** `stopwaitsecs=50`. Together with the agent's `--stop-timeout 60`, this means the RS-289 SIGTERM save and backup always finish.
- **`Dockerfile`:** `SCREEN_GEOMETRY=1920x1080x24`, fixed. The profile's `screen`/`viewport` emulate each device on top of it.

**Pinning.** Update the pin in `VENDOR.md`. The patched commit also has to reach the main checkout's monitor clone before a deploy. That clone is now at `8958d2c`: check what that commit is and rebase on it if it is newer work.

### `rs_fleetd` (new package `trackers/facebook/rs_fleetd/`, stdlib plus the docker CLI)

Files:
- `rs_fleetd/{cli,agent,client,docker,plan,state}.py`
- `tests/`
- `deploy/Dockerfile.fleetd`
- `deploy/docker-compose.fleetd.yml`

**Compose setup.** The compose file mounts:
- `/var/run/docker.sock`;
- `RS_FLEET_ROOT` at the same path on the host and in the container, because worker bind-mount sources must be host paths;
- the shared `secrets.env`, which carries the `${PROXY_*}` values that the configs reference.

The env file sets `RS_FLEET_URL`, `RS_HOST_ID` and `RS_HOST_TOKEN`, and the service uses `restart: unless-stopped`.

**Reconcile loop**, every 30 seconds:
1. Fetch the desired state.
   - **On success:** save it atomically to `<root>/desired.json`.
   - **On any error:** load the cached copy and go **offline**, which means fail-static.
2. **Online only:** fetch any config whose sha256 has changed into `<root>/workers/<id>/config.toml`.
3. **Plan against the containers.** The candidates are those labelled `rs.fleet.managed=1`, plus adopted ones from `overrides.toml`.
   - **Missing:** RUN.
   - **Spec hash label differs:** RECREATE (`stop -t 60`, `rm`, `run`), at most one per tick.
   - **Not desired:** STOP_REMOVE, but only if online and authoritative. `/data` is never deleted.
4. Report when online.

**`docker run` shape:**
- `--name rs-worker-<id>`
- labels for the spec, worker and version
- `--restart unless-stopped --stop-timeout 60 --shm-size 1g`
- `-v <root>/sessions/<id>:/data`, the config mounted read-only, and a named cache volume
- the `rs-fleet` network locally, or VNC published on the LAN IP from a remote host
- the image is pulled from `10.10.10.73:5000` when it is missing

**Migration commands:**
- `--observe-only` prints the plan and reports without applying anything.
- `rs-fleetd adopt --worker va-1 --container rs-monitor-va1 --data-dir … --cache-volume …` lets the first rollout take over the existing session directories and caches in place.

### Console, deploy and images

**`rs_console`**
- `ACCOUNT_WRITE_FIELDS` passes `fb_uid` through.
- `settings.targets()` is the union of the env list and the coordinator's assignments.
- Configs for new workers are rendered from the region, reusing the logic in `deploy/make-region-config.py`.
- Every config save, `settings apply`, and a 60-second loop publish through `PUT /v1/fleet/configs/{id}`.
- `_vnc_targets()` merges `fleet_assignments.vnc_target`.

**ERP** (`facebookPool.ts` `/assign`): sends `fb_uid: row.uid`. This is additive. The console ships first, then the ERP release: a root version bump, `CHANGELOG.md`, and `tests/` for the route.

**`scripts/deploy.sh`**
- **Phase 1 (interim):** recreate all of the `homelab*` compose services, not just `rs-monitor`.
- **Once the agent is authoritative:**
  - build `aimm-recycle:$VERSION` (also tagged `:latest`) and push it to the LAN registry;
  - run `rsc fleet release $VERSION`;
  - poll `/v1/fleet/state`;
  - `verify()` checks the first worker that rolled.

**Other scripts**
- `scripts/build-monitor-image.sh` tags `:$VERSION`.
- `scripts/fleet-verify.py` also reads the `rs.fleet.worker` label.
- `scripts/release.sh` runs `rs_fleetd/tests`.
- The deploy rsync filter and its test include `rs_fleetd/`.

**LAN**
- `docker-compose.coordinator.yml` also publishes `10.10.10.73:8500`. Every route already needs a worker, host or admin token.
- A new `deploy/docker-compose.registry.yml` runs `registry:2` on `10.10.10.73:5000`, LAN only. The monitor is AGPL, so the registry is never public.

## Delivery: four PRs to `dev`, each with its own suite run

| PR | Contents | Release |
| --- | --- | --- |
| 1. Identity and session persistence | `device_profiles`, the identity endpoints, the restore guard, `datr` capture, the monitor patch and new pin, fixed Xvfb, the stop timeout, console `fb_uid`, interim `deploy.sh` that recreates every worker | facebook-tracker 0.11.0 |
| 2. ERP `/assign` sends `fb_uid` | backend route and test | ERP patch bump + CHANGELOG |
| 3. Fleet control plane and `rs_fleetd` | fleet tables, host tokens, desired/report/config, scaling and rollout ticks, `rsc fleet`, `retired_at`, console config publishing and VNC discovery, `deploy.sh` release mode, adopt and observe-only | facebook-tracker 0.12.0 (**Breaking**: workers become `rs-worker-<id>`; compose files retired after migration) |
| 4. Second host on the LAN | coordinator on the LAN, registry compose, pull-on-missing, VNC on the LAN IP, add-host runbook | facebook-tracker 0.13.0 |

**Gated on the user's go-ahead.** Each step that touches the homelab is outward-facing and waits for a yes:
- each tracker deploy to the homelab;
- `rsc fleet enable` for the 10 slots;
- adopting in observe-only mode;
- switching the agent to authoritative and running the first rollout;
- deleting the old compose files.

## Failure modes (requirement: either side can break)

| Failure | Workers | Agent | Coordinator |
| --- | --- | --- | --- |
| Coordinator or Postgres down | Keep searching. Control-plane calls return None. Boot uses the `/data` cache: `identity.json`, `fb_state.json`, config. | Uses cached `desired.json`, stops nothing, restarts cached workers after a reboot. | — |
| Agent down | Unaffected (Docker restart policy). | Restarts and reconciles from the cache. | The host goes stale. The rollout skips it and new placements avoid it. |
| A new image crash-loops | Other workers unaffected. | One recreate per tick. | Gate timeout reverts that worker and fails the release. |
| Host lost | Its workers are down. | — | No automatic move. `rsc fleet move --force` restores the session from the snapshot, and the device comes from the DB. |
| Account swapped in the ERP | The old session is quarantined and the new account's device is applied. | Recreates only if the spec changed. | — |
| Vault key missing | Identity and restore return 503, so workers fall back to the cache. | — | The rest of the API keeps working. |

## Verification

**Unit and integration suites** (commands from `trackers/facebook/AGENTS.md`):
- `rs_coordinator/tests`: new `test_device_profiles.py` and `test_fleet.py`, plus additions to `test_session_backup.py`, `test_accounts.py` and the `TABLES` in `test_postgres.py`. Also run the Postgres case against a throwaway database on port 55439, never 5432 or 55432.
- `rs_console`, run from inside `rs_console/`: `fb_uid` passes through, VNC targets merge, configs publish.
- `rs_fleetd/tests`:
  - **`test_plan.py`:** RUN, RECREATE, offline never stops anything, at most one recreate per tick, adoption.
  - **`test_state.py`:** atomic and corrupt cache.
  - **`test_docker_args.py`:** the shape of the `docker run` arguments.
  - **`test_client.py`:** errors return None.
- Monitor tests:
  - **`test_identity.py`:** the whole `ensure_local_identity` matrix.
  - **`test_session_persistence.py`:** context options, `datr` injection, user-agent version.
  - **`test_relogin.py`:** a swap drops the old `datr`.
  - **`test_control_plane.py`:** the GET/PATCH calls and `host_id`.
- `scripts/release.sh --dry-run minor` checks the gates and suites in one go. The ERP side runs `pnpm --filter recycle-erp-backend test`.

**Local end-to-end, no Facebook involved:**
1. Run the coordinator on SQLite (`env -u DATABASE_URL -u RS_DATABASE_URL`) and `rs-fleetd` against local Docker, with a stub worker image (a `busybox` tagged `:v1` / `:v2`).
2. `rsc fleet add-host`, then enable two slots. Two `rs-worker-*` containers should appear.
3. `rsc fleet release v2`. Send heartbeats with minted worker tokens using `curl`. The rollout should advance one worker at a time. A missing heartbeat should fail it and revert that worker.
4. Stop the coordinator. The containers should stay and the agent log should say it is offline.
5. Stop the agent. The containers should keep running.
6. Disable a slot. Its container should stop and its `/data` should remain.

**Identity in a real browser:**
1. In `.venv-aimm`, open a headless Playwright context through `create_page` with a profile. Check that `navigator.userAgent`, `screen.width` and `Intl.DateTimeFormat().resolvedOptions().timeZone` match the profile and that `datr` is in the jar.
2. Delete the local `fb_state.json` and start again. It should be restored from the coordinator.
3. Swap the identity. The old file should be quarantined and the new cookies applied.

**On the homelab, after approval:**
1. Run `rs-fleetd --observe-only`. The plan should contain only adopt-RECREATEs.
2. During the first rollout, watch each worker reach HEALTHY on the new version with no `SESSION_EXPIRED`.
3. Check that the `device_profiles` rows match the user agent each worker presented before.
