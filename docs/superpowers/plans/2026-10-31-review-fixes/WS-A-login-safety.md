# WS-A — Facebook-login safety: fix plan

Planned on `origin/dev` f0c1d856 (ERP v1.396.0, facebook-tracker 0.15.0).
Planning only: no code, no live action was taken. Ticket labels `WS-A-n` get a
real `RS-nnn` from `scripts/ticket.sh new` when each is started.

## 1. Goal and scope

Cut every Facebook login that happens without a person meaning it. This covers
the legacy Mac jobs, the ERP fleet's claim/lease/count logic, pool Assign and
the editor, the one-click login controls, the fleet agent on the hosts, and
the coordinator's account and session invariants. A few off-scope findings
were filed into this workstream (A4-05, A4-06, B3-03, B3-04, B4-02). They get
small tickets here so none of them is lost.

Findings covered (26): A10-04, A10-06, A10-09, A10-17, A10-18, A10-19, A4-01,
A4-02, A4-03, A4-04, A4-05, A4-06, A6-05, A6-06, B3-01, B3-03, B3-04, B3-05,
B3-06, B3-07, B4-01, B4-02, B4-07, B5-01, B5-02, C2-01. A10-16 is B5-01's
duplicate and closes with WS-A-1.

### What reading the code on f0c1d856 changed

- **The homelab count is not set by a person (B3-01).** The B3 evidence shows
  `desired.count` changed 13 times in 24 h, and `hosts.ts:239` `workerCount`
  derives it from held and free fleet slots. Lapsed leases and freed walled
  accounts drive it, so the owner's "who changed it" question has a code
  answer: WS-A-2 and WS-A-3.
- **Lowering the count no longer removes workers at HEAD.** `apps/fleet-agent/src/plan.ts`
  leaves running workers above the count alone. The `remove … beyond count`
  lines in B3-01 come from agent 1.380.1 (B4-01), so the agent swap fixes
  B3-01 fix (2), "debounce decreases". WS-A-6 makes it stick.
- **Exit-75 restarts are not logins (B3-01 evidence).** homelab-8 had 56
  restarts and only 3 ledger logins, because a slotless boot exits before it
  signs in. B3-01 fix (3), counting soft restarts per day, is therefore
  dropped (see §4). The logins come from a successful claim of a lapsed or
  freed slot, often an account that is already walled.
- **The `/facebook-pool/:no/assign` path (A4-03, A6-06, A10-04) still works
  but nothing live uses it.** It writes to the legacy coordinator workers
  through rs_console. All 41 of those workers were retired on 2026-10-27
  (B3-07), but `rs_coordinator/fleet.py:156` un-retires one when it is
  re-assigned. Live ERP-fleet workers take their account from `fleet_slots`
  at claim time. Whether to harden this path or delete it is owner gate G3.
- **ERP-fleet workers still talk to the coordinator.** `rs_worker/entry.py:278`
  hands them `coordinator_url` as the control plane for escalations and
  backups, using per-worker tokens. So the coordinator's account and session
  invariants (A10-04/06/09) still guard live workers.

## 2. Tickets

Versioning legend: **ERP** = root `package.json` bump + `CHANGELOG.md` section
(+ `docs/FEATURES.md` when behaviour changes). **FBT** = `trackers/facebook`
`[Unreleased]` → `scripts/release.sh` → tag `facebook-tracker/vX.Y.Z`.
**Ops** = no code; owner-run steps only. "Login?" says whether shipping it
starts any worker container.

### Summary

| Ticket | Title | Findings | Sev | Versions | Login on ship? | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| WS-A-1 | Retire the legacy Mac Facebook jobs | B5-01 (+A10-16), B5-02 | P1 | Ops + FBT docs | No (stopping closes a browser) | S |
| WS-A-2 | Lapsed lease of a live worker stays held | A4-01 | P2 | ERP | No | M |
| WS-A-3 | Hold walled accounts instead of re-booting them | B3-01 | P2 | ERP | No | M |
| WS-A-4 | Server-side login confirm + confirm dialogs | A6-05, A6-06 | P2 | ERP | No | M |
| WS-A-5 | Pool Assign claim-first; editor keeps a resealed session | A4-03, A4-02 | P2 | ERP | No | L (S if G3 = retire) |
| WS-A-6 | Fleet agent current on every host, version floor, log caps | B4-01, B3-05 | P2 | ERP + Ops | No (agent swap is not a login) | M |
| WS-A-7 | Coordinator: one account per worker, own-account lock, guarded backups | A10-04, A10-06, A10-09 | P2 | FBT | No (coordinator-only recreate) | M |
| WS-A-8 | AGENTS.md first rule names the ERP fleet | C2-01 | P2 | docs-only | No | S |
| WS-A-9 | Fleet search radius and card parser | B4-02 | P2 | FBT (worker image) | **Yes**, rides the next planned fleet release | M |
| WS-A-10 | Proxy delete leaves no sealed URL for an unpark | A4-04 | P3 | ERP | No | S |
| WS-A-11 | Session tooling: logged-in guard, device and lock, proxy clear | A10-17, A10-18, A10-19 | P3 | FBT | No (operator tools, not in the worker image) | M |
| WS-A-12 | Homelab VM tidy-up: console poll, tree stamp, fleet.toml, dead worker | B3-06, B3-07, B4-07 | P3 | FBT + Ops | No, except B4-07 if the owner says yes | S |
| WS-A-13 | Homelab ops: OpenSearch exposure/retention, log-sync token | B3-03, B3-04 | P3 | Ops | No | S |
| WS-A-14 | ERP proxy path params validated; Shippo push treated as a hint | A4-05, A4-06 | P3 | ERP | No | M |

---

### WS-A-1 — Retire the legacy Mac Facebook jobs (P1)

Closes **B5-01** (and its duplicate A10-16) and **B5-02**. Versions: Ops, plus
a docs-only FBT change (no release needed: the plists and README are not
shipped code, but record it under `[Unreleased]`). Login on ship: none.
Stopping a monitor closes a browser.

**Change**
- Owner, on the office Mac, after G1:
  `launchctl bootout gui/501/com.recycleservers.fbmonitor`,
  `launchctl bootout gui/501/com.recycleservers.fbmonitor-watchdog` and
  `launchctl bootout gui/501/com.recycleservers.search-probe`. Then move the
  three plists from `~/Library/LaunchAgents/` to `~/Projects/_archive/launchagents-2026-10/`.
  Leave `configs/sessions/personal.json` untouched until all three are unloaded.
  `keyword-eval` (B5-03) belongs to another workstream, and the same bootout
  works for it.
- Repo: delete `trackers/facebook/deploy/com.recycleservers.search-probe.plist`.
  Its path, `/Users/jinhu/Development/...`, does not exist, and reloading it
  would bring the job back. `keyword-eval.plist` goes with B5-03's owner.
  Mark `scripts/probe-search-url.py`/`.sh` as retired in their header and in
  `trackers/facebook/README.md`. If G1 says the probe is still wanted, the
  follow-up is a logged-out rewrite using the `/marketplace/<seg>/` resolver;
  that is deferred, see §4.
- Add a line to `docs/review-2026-10-31/`'s successor checklist (or
  `docs/agents/erp-ops.md` → *Office Mac*): no `com.recycleservers.*` job may
  reference `~/Projects/recycle_servers/facebook_tracker`.

**Tests**: none (operational). The read-only check is the verification below.
Nothing under `repro/B5-verify/` needs porting.

**Owner gates**
- G1: "Unload `com.recycleservers.fbmonitor`, its watchdog and `search-probe`
  now, and archive their plists?" (yes/no)
- G1b: "Is `configs/sessions/personal.json` the same Facebook account as any
  pool or fleet account?" If yes, list that account on the next fleet check;
  it was seen from two IPs.

**Rollout and verification**: `launchctl list | grep recycleservers` shows
none of the three, and `pgrep -fl chrome-headless-shell` shows nothing
parented by `aimm`. `~/Projects/recycle_servers/facebook_tracker/reports/`
stops gaining `search-probe-<date>.md` files. Rollback: move the plist back
and run `launchctl bootstrap gui/501 <plist>`. That is not recommended.

**Effort**: S.

---

### WS-A-2 — A lapsed lease whose worker is alive stays held (P2)

Closes **A4-01**. Versions: ERP. Login on ship: none. Ships on the normal
Railway deploy, and agents and workers are untouched.

**Change**
- `apps/backend/src/fleet/hosts.ts` `workerCount` (:239-265): a slot counts
  as **held by host H** when its lease is live *or* its `worker_id` matches a
  running container in H's last report (`reportOf(h.report).containers`,
  `running`) *or* `fleet_workers.last_heartbeat_at` for that worker is within
  `FRESH_HEARTBEAT_MS` (already defined in this file). Such a slot is not
  `free`. The `highest` floor (:263) is computed from these held rows, so it
  cannot drop to 0 after an outage.
- `apps/backend/src/fleet/claim.ts` free-slot query (:347-355): add a
  "not alive elsewhere" condition. A lapsed slot whose `worker_id` differs
  from the claimer and that is still alive by the same test (a fresh heartbeat
  via `LEFT JOIN fleet_workers`, or the container in its host's report) is
  skipped. Put the test in one SQL helper, `slotAliveSql(tx)` in
  `fleet/sql.ts`, so `workerCount` and claim cannot drift apart.
- `apps/backend/src/fleet/auth.ts` `eligibleSlot` (:254): no change. A
  surviving worker renewing its own lapsed lease is the desired recovery.
  Add a comment saying why.
- A boot grace is not needed once liveness is checked, so the reviewer's
  alternative is not taken.

**Tests**: `apps/backend/tests/fleet-hosts.test.ts` and
`apps/backend/tests/fleet-claim.test.ts`, ported from
`docs/review-2026-10-31/repro/A4-verify/a4-01-lapsed-lease.test.ts` and
inverted. Seed two hosts with live workers and set every lease to
`NOW()-1min`, with `last_heartbeat_at` 2 min ago and the containers in the
reports. Assert that `GET /hosts/B/desired` keeps count = B's running workers,
and that a claim by a new worker id on B is `409 no_slot`. Control case: the
same slots with no heartbeat for 10 min and no container in the report are
claimable.

**Owner gates**: none.

**Rollout and verification**: merge to `dev` and check on inventory-dev that
the Hosts tab shows each host's `desired.count` equal to its running workers.
After release to `main`, read-only: over the next 24 h the agent log on the
homelab shows no `run … reason: missing` after any ERP restart. Rollback:
revert the PR. There is no schema change.

**Effort**: M.

---

### WS-A-3 — Hold walled accounts instead of re-booting them (P2)

Closes **B3-01**, the code half. Fix (1), "do not re-run a locked/challenged
account until a person clears it", is done here. Fix (2) is done by WS-A-6.
Fix (3) is dropped (§4). Versions: ERP, with a migration. Login on ship: none.

**Change**
- Migration `apps/backend/migrations/NNNN_fleet_slot_wall.sql` adds
  `fleet_slots.wall_state TEXT NULL`, `wall_at TIMESTAMPTZ NULL` and
  `wall_cleared_by TEXT NULL`. Update `docs/DATABASE.md` → ERP `fleet_slots`.
- `claim.ts` heartbeat (:480-545): when `fleetStateParked(state)` and the
  slot is not `fleetResumable` (DEAD connect_failed is a proxy fault, not a
  wall), set `wall_state = state, wall_at = COALESCE(wall_at, NOW())`. A
  `HEALTHY` heartbeat clears it, so a solved challenge un-walls itself. The
  live worker keeps its lease, and its open browser stays available for a
  VNC challenge solve.
- `claim.ts` free-slot query and the `mine` retry path: exclude
  `wall_state IS NOT NULL`. That includes the same worker id, because a
  re-boot is a login either way. `hosts.ts` `workerCount`: a walled slot is
  neither free nor counted as held once its worker is gone, so the count
  stops rising for walled accounts.
- The coordinator's login ledger outcome `locked`/`challenge` is not visible
  to the ERP. The worker's heartbeat state is the ERP's signal. If G4 wants
  ledger-driven holds as well, that is a follow-up.
- Manager action: `POST /api/fleet/slots/:no/clear-wall` in
  `apps/backend/src/fleet/workers.ts`, next to `/release-quarantine`. It
  stamps `wall_cleared_by`, requires the login confirm from WS-A-4, and logs
  `fleet wall cleared`.
- UI: `apps/frontend/src/pages/desktop/fleet/fleetBoard.ts`, plus the slot
  row in `FacebookAccountPool.tsx` and `FleetWatch.tsx`, show "Held: CHECKPOINT
  since …" with a "Let it log in again" button behind the WS-A-4 confirm.
  Shared type `FleetSlot.wall` goes in `packages/shared/src/fleet.ts`.
- `docs/FEATURES.md` → Fleet: walled accounts wait for a person.

**Tests**
- `apps/backend/tests/fleet-claim.test.ts`: a heartbeat in `CHECKPOINT`, then
  the lease lapses. A claim by any worker id is `409 no_slot`, and
  `/hosts/:id/desired` does not count it. After `clear-wall` it is claimable.
  A HEALTHY heartbeat clears the wall. DEAD connect_failed does not wall.
- Fleet-agent unit test (the reviewer's suggestion): `apps/fleet-agent/tests/plan.test.ts`
  asserts that a worker exiting 75 after a `no_slot` is not counted as a login
  (it is restarted at most per the existing `SOFT_LIMIT`). This is
  documentation of current behaviour, with no agent change.
- Ported from no repro. B3-01 is ledger evidence (`repro/B3-verify/B3-01-evidence.md`).

**Owner gates**
- G4: "Hold a slot on these states until a manager clears it: CHECKPOINT,
  CHALLENGE_*, and the lock page. Also SESSION_EXPIRED?" (Recommended: yes for
  all four, because SESSION_EXPIRED's next step is a password login.)
- G4b: "Before release, decide which currently walled accounts stay held."
  This is a read-only list from prod `fleet_workers.state`, run by the owner or
  through the Railway read recipe.

**Rollout and verification**: the migration is additive and safe on deploy.
On prod, read-only: compare the coordinator's `rsc vault logins --limit 100`
the day before and the day after. Boots on accounts whose previous outcome was
`locked`/`challenge` should drop to 0, and `desired.count` changes per day on
the homelab should fall from about 13 to a few. Rollback: revert the code. The
columns stay, unused.

**Effort**: M.

---

### WS-A-4 — One server-side login confirm, and dialogs on every login control (P2)

Closes **A6-05** and **A6-06**. It also starts the architecture item "one
server-side 'this causes a login' gate". Versions: ERP. Login on ship: none.

**Change**
- Backend: a helper `requireLoginConfirm(c)` in `apps/backend/src/fleet/auth.ts`
  wants body `confirmLogin: true` (and logs `by`). Without it the route
  answers `428 { error: 'login_confirm_required', starts: n }`. Apply it to:
  - `PATCH /api/fleet/hosts/:id` when it turns `authoritative` on or raises
    `capacity` above the current `desired.count` (`hosts.ts`). Compute
    `starts` = new `workerCount` − running.
  - `POST /api/fleet/workers/:id/relogin`, `/slots/:no/unpark`,
    `/slots/:no/clear-wall` (WS-A-3), `POST /api/fleet/releases`.
  - `POST /api/facebook-pool/:no/assign` (unless G3 retires it).
  - `/api/coordinator/workers/:id/relogin` in `routes/coordinator.ts`,
    checked before proxying.
- Frontend: `apps/frontend/src/pages/desktop/fleet/FleetHosts.tsx`.
  `authoritative()` turning on and `capacity(h, +1)` open a
  `ConfirmDialogBody` (from `fleet/shared.tsx`) that says "Starts up to N
  workers; each is a Facebook login" and passes `confirmLogin`. Turning it off
  stays one click.
- `FacebookAccountPool.tsx:164` `sendLogin`, `:827` `onSendLogin`, and the
  `save()` auto-send at `:183` (a holder change also queues a login with no
  confirm): route all three through `ReloginButton`'s confirm body
  (`FleetAccounts.tsx:94`). Extract that body as a `LoginConfirmBody` and
  reuse it.
- `lib/fleet.ts`, `lib/facebookPool.ts`, `lib/coordinator.ts`: send
  `confirmLogin: true` only from the dialog's confirm handler.

**Tests**
- Backend: `fleet-hosts.test.ts`, `fleet-worker-detail.test.ts` (relogin),
  `facebook-pool.test.ts` (assign) and `coordinator-routes.test.ts`. Each
  route without `confirmLogin` gets 428, and the facade mock or the DB is
  untouched. With it, today's behaviour.
- Frontend: there is no DOM environment (review *Limits*). Extract pure
  helpers `hostPatchStarts(host, patch)` and `poolSaveSendsLogin(original, draft)`
  into `fleet/fleetBoard.ts` and `accountPool/`, and unit-test them in
  `apps/frontend/tests/`. If WS-F lands a jsdom harness first, add the render
  tests the reviewer proposed (click the switch → `updateHost` is not called
  before confirm).

**Owner gates**
- G5 (README "Needs owner" 9): "Should every control that starts a worker
  container or queues a login require a confirm, server-enforced?"
  (Recommended: yes.)

**Rollout and verification**: the backend and the frontend deploy together
from `main`, so ship one PR. An older cached frontend gets 428 and shows the
error toast, which is a safe failure. Verify on inventory-dev, read-only: flip
the switch on an observe-only test host there and the dialog appears; cancel.
Do not confirm on prod. Rollback: revert.

**Effort**: M.

---

### WS-A-5 — Pool Assign claims first; the editor keeps a resealed session (P2)

Closes **A4-03** and **A4-02**. Versions: ERP, with a migration if G3 =
harden. Login on ship: none.

**Change, G3 = harden (default)**
- Migration: add `fb_pool_accounts.assigning_to TEXT NULL` and
  `assigning_at TIMESTAMPTZ NULL`. Update `docs/DATABASE.md`.
- `apps/backend/src/routes/facebookPool.ts` `pool.post('/:no/assign')`
  (:603-735):
  1. In `sql.begin`, `SELECT … FOR NO KEY UPDATE`. Re-run the
     retired/held/`fpWorkerTaken` checks under the lock. Refuse when
     `assigning_to` is set and younger than 10 min. Set
     `assigning_to = worker, assigning_at = NOW()`. Commit.
  2. Make the facade calls (vault PUT, session seed, restore or relogin) as
     today.
  3. Settle in a transaction: `UPDATE … SET status='fleet', … , assigning_to = NULL
     WHERE no = $1 AND assigning_to = $worker AND status <> 'taken'`. With 0
     rows, answer 409, log `assign lost its claim`, and do not move the
     `previous` accounts. On a facade refusal, clear the marker without
     changing status.
  4. The `pool.post('/:no/take')` and `PUT /:no` paths refuse while
     `assigning_to` is fresh (409 `fpAssigning`).
  5. Sweep: the existing pool housekeeping cron (or a new step in
     `fleet/scheduler.ts`) clears markers older than 10 min, the way
     `wechat_market_reruns` expire.
- A4-02, `pool.put('/:no')` (:456-492): the client sends `cookieAt` (the
  `cookie_at` it loaded), added to `PoolDraft` in `packages/shared` and
  `apps/frontend/src/lib/facebookPool.ts:39,77`. Server: if the stored
  `cookie_at` differs from `cookieAt` and `draft.cookie` equals what the
  client loaded (or the client did not change it, via a `cookieChanged`
  flag), keep `cookie_enc`, `cookie_uid`, `cookie_at` and `cookie_by`. If both
  changed, answer 409 `fpCookieMoved` ("a worker saved a new session; reload").
  Do the same for `token_enc`.

**Change, G3 = retire.** The legacy coordinator workers stay retired, and
the live fleet assigns through `fleet_slots`. Delete `/assign`,
`legacyDevice`, `poolApi.assign`, the editor's worker picker and Resend
button (`AccountEditor.tsx:200-232`) and the `fleet` prop wiring. A4-03 then
closes by deletion, and A6-06's wiring goes with it (WS-A-4 still covers the
fleet relogin). This also retires the undocumented ERP→console
`/session` and `/restore-session` calls (WS-I's C2-02). A4-02 is still needed.

**Tests** (`apps/backend/tests/facebook-pool.test.ts`), ported from
`repro/A4-verify/a4-03-assign-race.test.ts` and `a4-02-editor-lost-update.test.ts`,
inverted:
- With a stubbed facade, two concurrent `/assign` calls for one account to
  different workers: exactly one reaches relogin/restore, and the other gets
  409.
- A purchaser takes the account while the stubbed facade blocks: assign
  returns 409 and the row stays `taken`.
- A crash between the facade and the settle (throw in the stub after relogin):
  the marker remains, take is refused, and the sweep clears it.
- A4-02: load the snapshot, reseal via `PUT /api/fleet/worker/session`, then
  PUT the earlier draft with a new note. `cookie_enc` unseals to the worker's
  session and `cookie_by` is the worker id. Both changed → 409.

**Owner gates**
- G3: "Are the legacy coordinator workers (retired 2026-10-27) ever coming
  back? If not, delete pool Assign/Resend login instead of hardening it."
  (Recommended: retire. It is smaller, and it removes a login path.)

**Rollout and verification**: an additive migration, then the backend and
frontend together. Read-only check on prod: `fb_pool_accounts` has no
`assigning_to` older than 10 min a day later. Rollback: revert. The columns
stay.

**Effort**: L if hardened, S if retired (plus S for A4-02).

---

### WS-A-6 — The fleet agent is current on every host, with a version floor and log caps (P2)

Closes **B4-01** and **B3-05**. Versions: ERP (the agent is versioned by root
`package.json`; image `ghcr.io/jinhuw/fleet-agent:<root version>`), plus Ops.
Login on ship: none. Swapping `rs-fleet-agent` does not touch worker
containers, and the new `--log-opt` applies only to containers the agent
creates later. No worker is recreated for it.

**Change**
- `apps/fleet-agent/src/docker.ts` `runArgs` (:74-96): add
  `'--log-opt', 'max-size=10m', '--log-opt', 'max-file=3'`.
- Version floor: `FLEET_AGENT_MIN_VERSION` in `packages/shared/src/fleet.ts`,
  set to the version that carries RS-474 (the newest removal-race fix). In
  `hosts.ts` `hostView`, add `agent_outdated: boolean` from the reported
  `version`. `FleetHosts.tsx` shows a warning chip ("agent 1.380.1 is below
  1.39x; lowering capacity may remove signed-in workers"). While it is
  outdated, the capacity `-` button opens a confirm.
- `apps/fleet-agent/README.md`: the swap recipe (copy `FLEET_*` env,
  `docker stop -t 120`, run new with the same mounts). Point to it from
  `docs/agents/erp-ops.md`.

**Tests**
- `apps/fleet-agent/tests/docker.test.ts`: `runArgs` includes
  `--log-opt max-size=10m`.
- `apps/backend/tests/fleet-hosts.test.ts`: a host reporting `1.380.1` →
  `agent_outdated: true`; one at the floor → false.
- `plan.test.ts` already covers "beyond count stays" at HEAD.

**Owner gates**
- G6: "Push `fleet-agent:<this release's version>` and swap `rs-fleet-agent`
  on `worker@10.10.60.14` and the homelab, one host at a time?" Exact action:
  the recipe above. Until it is done, nobody lowers a host's capacity.

**Rollout and verification**: release ERP to `main`, then confirm the image
exists in GHCR, then G6. Read-only check: `docker inspect rs-fleet-agent
--format '{{.Config.Image}}'` on both hosts shows the new tag. The Hosts tab
chip is gone. Workers' `StartedAt` is unchanged across the swap (no worker
restarted). A worker created later shows `LogConfig.Config.max-size=10m`.
Rollback: run the previous agent image with the same env. That is not a login
either.

**Effort**: M (code S, swap S, verification S).

---

### WS-A-7 — Coordinator: one account per worker, own-account lock, guarded backups (P2)

Closes **A10-04**, **A10-06** and **A10-09**. Versions: FBT (coordinator).
Login on ship: none. Ship it as a **coordinator-only deploy**: rsync
`rs_coordinator/` and recreate the `rs-coordinator` service only (like the
console-only deploy recipe). Never use `deploy.sh`, which restarts workers
and verifies a retired topology (WS-G's A10-02). The ERP-fleet workers ride
out a short coordinator restart; their control plane calls retry.

**Change**
- A10-06, `rs_coordinator/db.py` SCHEMA + `pg.py`: a partial unique index
  `accounts(worker_id) WHERE worker_id IS NOT NULL` (SQLite and Postgres).
  Create it in the migrate step only after a dedupe check that **refuses to
  start** with a listing if duplicates exist (no silent pick). `cli.py:390`
  `vault set-account --worker`: do the same 409-style check as
  `routers/accounts.py:147-155`, and catch the unique violation in
  `store.put_account` and turn it into that 409 in both paths. Make
  `account_row_for_worker` (db.py:1968, pg.py:1218) assert at most one row.
  Update `docs/DATABASE.md`.
- A10-09, `routers/escalation.py` `_account_for` (:47-60) and :108-112:
  return the resolved account only. Keep `payload.account_id` as
  `claimed_account_id` on the challenge row (metadata). `lock_account` runs
  only for the resolved account. An unmapped worker's `locked` escalation
  still files a challenge, pages, and locks nothing.
- A10-04, `routers/session.py` `backup_session` (:151-215):
  1. Look up the worker's account. If that account has an `fb_uid` and the
     incoming jar's `fb_user_id_of` differs, answer 409 `"session belongs to
     another login; the slot's snapshot is kept"` and do not upsert.
  2. With the legacy fleet token (`worker is None`), refuse backups for a
     worker that has a per-worker token issued (require own-worker auth).
     Keep the legacy body `worker_id` only for workers with no token, until
     the legacy token is retired (WS-C / WS-G).
  3. `upsert_snapshot` (db.py:2059, pg.py:1316) is unchanged. The guard sits
     in the router.

**Tests** (`rs_coordinator/tests/`)
- `test_session_backup.py`: port `docs/review-2026-10-31/repro/A10/test_seed_overwritten_by_stale_backup.py`,
  inverted. Seed, then a stale backup with another uid → 409. `fb_user_id`
  stays the seeded uid, and restore returns 200. Legacy token + body
  `worker_id` of a tokened worker → 403.
- `test_accounts.py`: a second `set-account --worker va-1` via the CLI
  raises. A direct insert of a duplicate raises a unique violation, in both
  the SQLite and Postgres suites (Postgres on a throwaway port, never
  5432/55432).
- `test_escalation.py`: an unmapped worker posting `locked` for account X
  leaves X unlocked, and the challenge carries `claimed_account_id = X`.

**Owner gates**
- G7: "Run, read-only, `SELECT worker_id, count(*) FROM accounts WHERE worker_id
  IS NOT NULL GROUP BY 1 HAVING count(*) > 1` on the facebook-tracker
  Postgres, and decide which row keeps each duplicated worker." (README
  *Limits* says this count was never run.)
- G8: "Recreate `rs-coordinator` only (coordinator-only deploy) to ship
  facebook-tracker vX.Y.Z?" (not a login).

**Rollout and verification**: release FBT, then G7, then G8. Check
`/healthz`, then `docker logs rs-coordinator` for the index creation line. A
day later, `rsc vault logins` shows no `restore` 409 followed by a password
login. Rollback: recreate from the previous image. The index can stay.

**Effort**: M.

---

### WS-A-8 — AGENTS.md's first rule names the ERP fleet (P2, docs)

Closes **C2-01**. Docs-only push: no version bump, but see memory
"docs push cancels backend CI" and push it with or after a code PR.

**Change**
- `AGENTS.md` *First rule*: after "Starting a worker container", add the
  bullet "Anything that makes the ERP fleet start a worker". It names the
  fleet-agent (`apps/fleet-agent/`, one `rs-fleet-agent` per host), host
  capacity/authoritative changes (Monitors ▸ Facebook ▸ Hosts,
  `/api/fleet/hosts`), `POST /api/fleet/releases`, slot unpark and clear-wall,
  `POST /api/fleet/workers/{id}/relogin`, and `docker rm rs-fleet-<id>` on a
  host. Use the reviewer's text in the input, edited to match G5.
- `AGENTS.md` *Map*: a row for `apps/fleet-agent/` (TypeScript, Node 24,
  docker CLI; homelab + `worker@10.10.60.14`; image
  `ghcr.io/jinhuw/fleet-agent:<root version>`; versioned by root; doc
  `apps/fleet-agent/README.md`). Change the `trackers/facebook/` row to say
  the legacy compose workers were retired on 2026-10-27.
- `trackers/facebook/AGENTS.md` (*Versioning, releases, deploys*): one line
  saying live workers are the ERP fleet's, and that `deploy.sh`'s worker
  restart applies to the retired topology.
- Docs-lint test `scripts/tests/agents-map.test.sh`, or a vitest under
  `apps/backend/tests/docs-agents-map.test.ts` matching the repo's other doc
  checks: it fails when a top-level dir under `apps/` or `trackers/` has no
  Map row. Port the commands from `repro/C2-verify/checks.sh`.

**Owner gates**: G5's answer fixes the list of login-causing actions.

**Rollout and verification**: `grep -n fleet-agent AGENTS.md` shows both the
rule and the row, and the lint passes. Coordinate with **WS-I**, which edits
the same files for C1/C2-02: one of the two PRs rebases on the other.

**Effort**: S.

---

### WS-A-9 — Fleet search radius and card parser (P2)

Closes **B4-02**. This is search yield rather than login safety, but it ships
in the worker image, which is a login per worker. Versions: FBT (vendored
monitor patch on `recycle-patches`, `VENDOR.md` pin bump, worker image).
Login on ship: **yes**. Every worker is replaced in a fleet release. Never
ship it alone. It rides the next fleet release the owner already plans,
together with any WS-G worker-image change.

**Change**
- Investigate first, read-only: one worker's VNC screenshot (viewing is not a
  login) and the vendored monitor's search URL builder and location-dialog
  code in `ai-marketplace-monitor/` (`search`/`retrieve`). Decide whether
  Facebook honours `radius` from the URL or only from the account's saved
  location dialog (which shows 40 miles).
- Fix in the vendored monitor: apply the radius the way Facebook honours it,
  and repair the card parser's index assumption (`list index out of range`,
  about 1,550 a day).
- Separately: is the query strings' specificity part of the cause? That is a
  `master`/ERP search-settings change (`/api/fleet` settings `search`), with
  no image needed. Try it first on dev settings.

**Tests**: vendored monitor unit tests, run with `.venv-aimm`. A search URL
for radius=100 carries the parameter Facebook honours. A parser fixture from
a current card HTML that raised `IndexError` now parses. Also run
`scripts/check-vendor.sh`.

**Owner gates**
- G9: "Ship the radius/parser fix in the next fleet release you are already
  planning (one login per worker), not on its own?" (yes/no + which release)
- G9b: "Check worker -5's account (276 of 284 empty searches)": a read-only
  look at its VNC.

**Rollout and verification**: `POST /api/fleet/releases` on the owner's
schedule. Read-only, 24 h later: the share of `[City] Done … 0 cards` drops
from about 45%, and the parse errors are near 0 (OpenSearch `fb-tracker-*`).
Rollback: release the previous image, which costs another login per worker,
so test on one host first if the owner allows.

**Effort**: M. **Dependency**: WS-G owns the vendored monitor and the release
cadence. Coordinate the release with it.

---

### WS-A-10 — Proxy delete leaves no sealed URL for an unpark (P3)

Closes **A4-04**. Versions: ERP. Login on ship: none.

**Change**
- `apps/backend/src/fleet/proxies.ts` `proxies.delete` (:159-173): in the
  same transaction, `UPDATE fleet_slots SET proxy_url = NULL WHERE proxy_id = $id`
  (parked included) before the delete.
- `workers.ts` `/unpark` (:305-320): refuse with `409 no_proxy` ("pick a proxy
  first") when `proxy_id IS NULL` and fleet settings require a proxy.
- `claim.ts:347-355`: add `AND s.proxy_id IS NOT NULL` to the free-slot query
  when a proxy is required, so the per-proxy cap (keyed on `proxy_id`) always
  sees the slot.
- `FleetProxies.tsx` remove dialog: say that parked slots on this proxy lose
  it.

**Tests**: `apps/backend/tests/fleet-proxies.test.ts`. Add a slot, park it,
delete its proxy and unpark: 409 `no_proxy`, and `proxy_url` is NULL. A
claim never returns the deleted URL. There is no repro to port (P3,
unverified).

**Owner gates**: none.

**Rollout and verification**: normal ERP release. Read-only on prod: `SELECT
count(*) FROM fleet_slots WHERE proxy_id IS NULL AND proxy_url IS NOT NULL` = 0
after the release. Run a one-off nulling in the migration if it is not 0.
Rollback: revert.

**Effort**: S.

---

### WS-A-11 — Session tooling: logged-in guard, device and lock, proxy clear (P3)

Closes **A10-17**, **A10-18** and **A10-19**. Versions: FBT (`rs_poster`,
`scripts/`). Login on ship: none. These are operator tools on the
Mac/VM, not in the worker image (memory: the worker image has no rs_poster),
so a release with no deploy is enough. Note: running `check` or
`browse-session` is itself a session use. These fixes make it safe, not free.

**Change**
- A10-19, `rs_poster/rs_poster/cookies.py:311-318`: on capture and import,
  write `proxy` explicitly and `meta.pop('proxy', None)` when absent. Callers
  are `session_cli.py:269-274,504-509`.
- A10-18, `session_cli.py:557-586` `check`: build the context with
  `device_context_options(sidecar)` and `proxy_settings` as
  `PosterSession` does (`session.py:195-200`), and hold `account_lock`.
  `--save-refreshed` writes through `atomic_write_text`, only when `xs` is
  present and the lock is held. `deploy/README.md` → *Keeping sessions
  alive*: cron uses `rs-session info` only, and `check` is an operator
  action.
- A10-17, `scripts/browse-session.py:33-47,64`: build on `PosterSession`
  (device options, sidecar proxy, `account_lock`). Replace the 5 s
  `storage_state(path=…)` with a save only when `xs` is in the cookies, via
  `atomic_write_text`, including `indexed_db`.

**Tests**
- `rs_poster/tests/test_cookies.py`: capture with a proxy, then without; the
  meta has no proxy.
- `rs_poster/tests/test_session_cli.py`: `check` builds context kwargs equal
  to `PosterSession`'s for the same sidecar, and takes the lock.
- `scripts/tests/` (the scripts suite, 37 tests today): a fake context whose
  cookies lack `xs` leaves the session file byte-identical.

**Owner gates**: none.

**Rollout and verification**: `scripts/release.sh patch`. Nothing to deploy.
Check that `deploy/README.md` no longer schedules `check --save-refreshed`.
Rollback: revert.

**Effort**: M.

---

### WS-A-12 — Homelab VM tidy-up: console poll, tree stamp, fleet.toml, dead worker (P3)

Closes **B3-06**, **B3-07** and **B4-07**. Versions: FBT (console + configs)
+ Ops. Login on ship: none, except B4-07 if G11 = yes.

**Change**
- B3-07, rs_console: in the session-meta poll (find the loop calling
  `/v1/session/{id}/meta` in `rs_console/rs_console/app.py` /
  `fleet_view.py`), skip workers whose `health.retired_at` is set, the same
  filter as `proxies_health` (`app.py:779`).
- B3-06: commit the VM's `configs/fleet.toml` retirement (comment out the
  legacy `[worker.*]` pins, `trackers/facebook/configs/fleet.toml:66-110`),
  so a sync cannot restore them. Make the console-only and coordinator-only
  deploy recipes stamp `.rs-deployed`. Add that as a `scripts/deploy.sh
  stamp` subcommand that rewrites `.rs-deployed` and `VERSION` and touches
  nothing else. The host cron scripts (`~/fleet-ai-bridge/*.py`) are
  released with this tag. Note them in `trackers/facebook/README.md`.
- B4-07: no code. Update `docs/superpowers/plans/2026-10-24-erp-fleet/HOSTS.md:53`
  with the decision.

**Tests**: `rs_console/tests/test_fleet.py` (run from inside `rs_console/`):
the poll does not request meta for a retired worker.
`scripts/tests/test-deploy-filter.sh`: `stamp` touches only `.rs-deployed`
and `VERSION`.

**Owner gates**
- G10: "Ship it with the WS-A-7 coordinator-only deploy, also recreating
  `rs-console`?" (not a login; ride one maintenance window).
- G11: "`docker rm rs-fleet-worker-60-14-2`?" The agent then creates a fresh
  worker on the prod URL, and its first claim is **a login**. After that, the
  dev→prod forward (`FLEET_FORWARD_URL`, `FLEET_FORWARD_PROXY_SECRET` on the
  dev Worker) can be removed. (Recommended: yes, but only after WS-A-6's agent
  swap and WS-A-3, so the new worker cannot land on a walled account.)

**Rollout and verification**: the coordinator 404s on `/v1/session/*/meta`
fall from about 4.8k a day to about 0. `rsync -anc` of `configs/fleet.toml`
shows no change, and `.rs-deployed` names the shipped tag. After G11, the
HOSTS.md grep prints nothing on both hosts. Rollback: recreate the console
from its previous image.

**Effort**: S.

---

### WS-A-13 — Homelab ops: OpenSearch exposure and retention, log-sync token (P3)

Closes **B3-03** and **B3-04**. Ops only, with no login. They are kept here
because they were assigned here. **WS-B** (ops alerting) and **WS-C**
(secrets) are the natural owners if the coordinator moves them.

**Change** (owner-run on 10.10.10.73, in `~/opensearch/docker-compose.yml`
and crontab)
- B3-03: bind `127.0.0.1:9200` and `127.0.0.1:5601`, plus the docker network
  the fleet-alert sender, the verdict bridge and the workers use. First check
  which LAN clients read 9200: the workers' `AIMM_OPENSEARCH_URL` on
  10.10.60.14 does, so that host needs a firewall allow rule rather than a
  loopback bind. Add an index template with `number_of_replicas: 0` and an
  ISM policy that deletes `fb-tracker-*`/`worker-logs-*` after 90 days.
  Recreating the OpenSearch container is not a login.
- B3-04: either a read-only Railway project token for the `reddits-tracker`
  logs (rotated with the 2026-10-21 set, name only in `secrets.env`), or
  remove the Railway leg from `~/bin/sync-worker-logs.sh`. Add `logrotate`
  for `~/worker-logs/sync.log`.
- Record both in `docs/agents/erp-ops.md` (homelab section).

**Tests**: none (ops).

**Owner gates**
- G12: "Restrict OpenSearch to loopback plus 10.10.60.14, set replicas 0 and
  90-day retention?"
- G13: "Give the VM a read-only Railway token for worker logs, or drop the
  Railway leg?"

**Rollout and verification**: from the office Mac, `curl -m3
http://10.10.10.73:9200/` is refused. `_cluster/health` is green. From
10.10.60.14 a worker still indexes (newest `fb-tracker-*` doc < 10 min old).
`grep -c 'FAIL railway' ~/worker-logs/sync.log` stops growing. Rollback:
restore the compose file.

**Effort**: S.

---

### WS-A-14 — ERP proxy path params validated; Shippo push treated as a hint (P3)

Closes **A4-05** and **A4-06**. Neither is a login path. They came in from
lane A4. Versions: ERP. Login on ship: none. **WS-E** (backend integrity) may
take them instead. If it does, drop this ticket and note the move.

**Change**
- A4-05, `apps/backend/src/routes/coordinator.ts:249-250,500-506,520-524`
  and `routes/tracker.ts:85-93,113-116`: validate each forwarded id before
  building the path. Use `WORKER_ID` for workers, an int/uuid rule for
  challenges and rules, and the subreddit rule for subreddits. Reject `.` and
  `..` with a 400. Put it in one `safeSegment(re, v)` helper in each file.
- A4-06, `apps/backend/src/routes/shippoWebhook.ts:39-67`: on
  `track_updated`, re-read `GET /tracks/{carrier}/{number}` through the
  existing `shipping/track.ts` poller function and apply that answer, not
  `body.data`. Ignore `test: true` in production.

**Tests**
- `apps/backend/tests/coordinator-routes.test.ts` and
  `tracker-routes.test.ts`: every param route with `%2E%2E` → 400, and the
  upstream fetch mock is never called.
- `apps/backend/tests/shippo-webhook.test.ts`: the mocked Shippo API reports
  TRANSIT, a DELIVERED push arrives, and the package stays `in_transit` with
  no notification.

**Owner gates**: none.

**Rollout and verification**: normal ERP release. Read-only: the Shippo
webhook log shows `re-read` lines, and packages still move to delivered
within one poll. Rollback: revert.

**Effort**: M.

## 3. Order

| Step | Ticket | Why here |
| --- | --- | --- |
| 1 | WS-A-1 | P1, and it costs only an owner bootout: the cheapest stop of an active login risk. |
| 2 | WS-A-6 (G6 swap) | The 1.380.1 agent still removes signed-in workers on a count drop. Until it is swapped, every other fleet change is riskier. The swap can use the current root version's image if it was pushed. The code half (log caps, floor) follows in its own PR. |
| 3 | WS-A-3, then WS-A-2 | Stop re-booting walled accounts (most of the 20/31 bad logins), then close the outage cascade. Both touch `claim.ts`/`hosts.ts`, so merge them sequentially and share the `slotAliveSql` helper. |
| 4 | WS-A-4 | The server-side confirm. WS-A-3's clear-wall and WS-A-5's assign use it, so WS-A-3 ships clear-wall behind a plain confirm dialog first and adopts `confirmLogin` when WS-A-4 lands. |
| 5 | WS-A-5 | After G3. If retired, it is quick, and it simplifies WS-A-4's pool part. |
| 6 | WS-A-7 + WS-A-12 | One FBT release, one maintenance window: the coordinator and console recreate (G8, G10). No worker is touched. |
| 7 | WS-A-8 | Docs. Land after G5, rebase with WS-I. |
| 8 | WS-A-10, WS-A-11, WS-A-14, WS-A-13 | P3s, in any order. |
| 9 | WS-A-9 | Only with the next owner-planned fleet release. |
| 10 | G11 (B4-07) | After steps 2–3, so the fresh worker cannot claim a walled account. |

Cross-workstream dependencies:
- **WS-G** (facebook tracker): A10-02 (`deploy.sh` verifies a retired
  topology) must not be used for WS-A-7/12. WS-G also owns the vendored
  monitor and the release cadence for WS-A-9.
- **WS-C** (secrets/edge): A10-01 splits `secrets.env` and recreates the
  console. Combine that recreate with WS-A-7/12's window. WS-C also retires
  the legacy fleet token (WS-A-7 step 2's end state).
- **WS-D** (deploy gates): makes the agent image part of the release, which
  keeps B4-01 from recurring. WS-A-6 adds only the visible floor.
- **WS-F** (frontend): a jsdom harness would let WS-A-4 add render tests.
- **WS-I** (docs): C2-02 (ERP→console `/session`/`/restore-session` contract)
  shrinks to nothing if G3 = retire. Both edit `AGENTS.md`.
- **WS-B / WS-E**: may take WS-A-13 / WS-A-14 (see each ticket).

## 4. Dropped / deferred

| Item | Status | Reason |
| --- | --- | --- |
| B3-01 fix (3), soft restarts counted per account per day | Dropped (the rest of B3-01 is in WS-A-3/6) | The evidence shows exit-75 restarts are slotless and log nobody in (homelab-8: 56 restarts, 3 logins). The logins come from claims, which WS-A-3/WS-A-2 gate. |
| B3-01 owner question "who changed the count" | Answered in code | `workerCount` derives the count from slot state. No person set it (B3 evidence). WS-A-2/3 stabilise it. |
| B5-02 logged-out probe rewrite | Deferred | Only if G1 says the probe is still wanted. Then it goes to `trackers/facebook/scripts/`, using the logged-out `/marketplace/<seg>/` resolver with no session. |
| A4-01 boot-grace alternative | Not taken | Checking liveness (heartbeat + host report) covers it without a timer. |
| Ledger-driven holds (coordinator `locked` outcome → ERP) | Deferred, G4 follow-up | The heartbeat state is enough for WS-A-3. Feeding the coordinator ledger into the ERP is a new contract. |

Every input finding is in exactly one ticket above. None was found already
fixed on f0c1d856. Each finding's cited code was re-read there (B-lane
findings from their evidence files).

## Owner gates (13)

G1 unload the Mac jobs (+ G1b personal.json identity) · G3 retire or harden
pool Assign · G4 which states hold a slot (+ G4b walled list) · G5
server-enforced login confirm · G6 agent push and swap · G7 coordinator
duplicate-mapping query · G8 coordinator-only recreate · G9 worker-image
release slot (+ G9b worker -5 VNC look) · G10 console recreate in the same
window · G11 `docker rm rs-fleet-worker-60-14-2` (a login) · G12 OpenSearch
lock-down · G13 VM Railway log token. (G2 is unused.)
