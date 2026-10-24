# WS-C · Worker image: fleet mode

**Depends on:** `CONTRACTS.md` §5 and §10 only; test against a mock server
until WS-B merges. **Owns:** `trackers/facebook/rs_worker/` (new),
`trackers/facebook/deploy/Dockerfile.worker`, the vendored monitor patch on
`recycle-patches` (new commit on top of `3a621a4`), `trackers/facebook/VENDOR.md`
pin, monitor tests `tests/test_fleet_mode.py`, tracker `CHANGELOG.md`
`[Unreleased]`.

Read first: `trackers/facebook/AGENTS.md`, `VENDOR.md`, memory notes on the
vendored monitor in worktrees; `facebook.py` `queued_cities` (~2071–2185),
`search()` (~2700–2850), `monitor.py` `start_monitor` (~723–829) and
`_run_all_jobs` / the `sweep` directive (commit 3a621a4), `control_plane.py`
`next_city` (~289–316).

## Tasks

### Entrypoint `rs_worker/entry.py` (stdlib + `httpx` already in the image)

1. If `RS_FLEET_URL`, `RS_FLEET_HOST_ID`, `RS_FLEET_HOST_TOKEN` are not all
   set: `exec` the current command unchanged (bind-mounted config). Byte-for-
   byte old behaviour.
2. Else: `POST {RS_FLEET_URL}/api/fleet/worker/claim` with the host token,
   `worker_id = RS_FLEET_WORKER_ID`, image version, `vnc_port = RS_VNC_PORT`.
   On `409 no_slot` → exit 75. On other failure → retry 3× (10 s) → exit 70.
3. Render into the container (never a bind mount):
   - `/root/.ai-marketplace-monitor/config.toml` from a template in
     `rs_worker/config.template.toml` (copy the structure of
     `configs/homelab-*.toml`): items (phrases, filters), search settings,
     `[marketplace.facebook]` with `storage_state_path`, proxy from
     `proxy.url`, user agent / viewport / timezone / locale from `device`,
     `coordinator_url` = `settings.coordinator_url` (listings keep going to
     the Python coordinator), and `fleet_url`, `worker_token`, `epoch`,
     `worker_id` under a new `[fleet]` table;
   - `/root/.ai-marketplace-monitor/session.json` as Playwright
     `storage_state` from `account.cookies`;
   - env `RS_FB_PASSWORD`, `RS_FB_TOTP` for the monitor's password fallback
     (only used when the cookie session is invalid, as today).
4. Serve `GET /healthz` on 8788 (`http.server` thread) once the monitor
   process is up; `exec` the monitor; propagate its exit code; map the
   monitor's stale-epoch exit to 75.

### Monitor patch: fleet mode (`recycle-patches`)

1. `config.py`: a `[fleet]` section (`url`, `worker_token`, `epoch`,
   `worker_id`, `poll_hold_seconds`). Fleet mode = section present.
2. `control_plane.py`: `FleetClient` with `next_task(done, wait)`,
   `heartbeat(state, …)`, `event(task_id, kind, detail)`, `upload_session()`.
   A 409 `stale_epoch` from any call raises `StaleEpoch`.
3. `monitor.py` `start_monitor`: in fleet mode skip `schedule_jobs`'
   `start_at`/interval jobs and run `fleet_loop()` instead of the idle loop:
   ```
   while True:
     if marketplace is parked (no page, wall, blocked session, relogin/restore pending):
         run the existing session checks; sleep 15; continue
     answer = fleet.next_task(done, wait=poll_hold_seconds)   # blocking HTTP, timeout wait+10
     done = None
     if answer is None: backoff (30 s → 10 min); continue
     if answer.task is None: continue                         # the server already held
     result = marketplace.search_task(answer.task)            # one city, one item
     done = {task_id, result}
   ```
   `StaleEpoch` → save nothing, close the browser, `sys.exit(75)`.
   The config-file watcher is irrelevant in fleet mode (no file changes).
4. `facebook.py`:
   - `search_task(task)`: the per-city body of `search()` (login check,
     search heartbeat, the phrase loop for `task.item`, the funnel reports to
     the coordinator, `[City]` start/finish/stop events now also sent to the
     fleet as `events`) for exactly one city with the radius the task gives;
     returns `{cards, opened, reviewed, alerted, seconds, stopped?}`.
   - `kind == 'verify-slug'`: open the Marketplace search URL for the slug,
     read the location label (port `scripts/check-cities.py`), report
     `finished` with `detail.location` and `detail.matches = label resembles
     task.city.name`; no listing is opened.
   - `kind == 'probe'`: a normal search whose result the server uses to lift
     quarantine.
   - Heartbeats in fleet mode go to the fleet (`FleetClient.heartbeat`) and
     carry `epoch`; the coordinator heartbeat is skipped (the coordinator
     still receives listings, claims and reviews).
   - The 30-minute session save also calls `upload_session()`.
   - **No own-list fallback in fleet mode.** `queued_cities`/`planned_cities`
     are not called.
5. Non-fleet mode: zero behaviour change. Run the full existing suite.
6. `tests/test_fleet_mode.py`: loop asks only when healthy; `task: null` →
   asks again, searches nothing; transport error → backoff, session kept;
   409 → exit 75 without a login; `verify-slug` reports the label; heartbeat
   carries the epoch; a wake never calls `login()`.
7. `Dockerfile.worker`: copy `rs_worker/`, `ENTRYPOINT ["python","-m","rs_worker.entry"]`,
   `HEALTHCHECK` on 8788, expose 5900. Build in CI (WS-F wires GHCR).
8. Update `VENDOR.md` pin, tracker `CHANGELOG.md` `[Unreleased]`, README →
   a *Fleet mode* subsection.

## Exit

- [x] Against the fake server in `rs_worker/tests/fake_fleet.py` (WS-B's
      backend did not exist yet): the entrypoint claims, renders config,
      session and identity, the monitor logs in once, receives a manual
      task, searches it (browser mocked), reports it done and receives the
      next task without a login; a stale epoch exits 75 without one
      (`rs_worker/tests/test_monitor_fleet_mode.py`,
      `test_entry.py`; the image built locally and ran against the fake
      fleet with made-up data). **Still open against WS-B's dev backend with
      a throwaway pool account and a listing reaching the coordinator**: WS-F's
      integration step; see the PR's follow-ups for the exact run.
- [x] Without the env vars the image runs the old way (`aimm --version`
      through the built image's entrypoint; `test_the_old_way_really_execs`)
      and the old suites pass (monitor: 547 passed, 1 skipped, the
      pre-existing 512 among them unchanged).

## Notes for the agent

- The vendored clone is gitignored; work in a worktree that has it and
  commit on `recycle-patches` (never push to upstream `origin`).
- `search()` is large; extract the per-city body into `search_task` without
  changing what the old path does — the diff of the old path should be a
  call site only.
- Secrets arrive in the claim answer and are written only inside the
  container's filesystem; never log them.
