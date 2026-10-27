# ERP fleet: an always-on city task queue for the Facebook workers

**Ticket:** RS-394 · **Spec:** [`../../specs/2026-10-24-erp-fleet-task-queue-design.md`](../../specs/2026-10-24-erp-fleet-task-queue-design.md) · **Owner:** jinhu · **Started:** 2026-10-24

This folder is the implementation plan, split so that several agents can work
it at once. Read this file, then [`CONTRACTS.md`](CONTRACTS.md), then your
workstream file.

## Review fixes before cutover

[REVIEW-FIX-PLAN.md](REVIEW-FIX-PLAN.md) and
[CLAUDE-REVIEW-HANDOFF.md](CLAUDE-REVIEW-HANDOFF.md) record the implementation
review and RS-400 fixes. Backend/agent/worker changes are implemented locally
on `fix/fleet-review-before-cutover`; see the handoff for final validation and
the separate vendor commit. No live cutover or deployment is implied.

## What we are building

Facebook Marketplace workers today sweep once a day at 13:00 UTC from
hand-written compose files on one homelab VM. The target: the ERP backend
owns a **task queue in Postgres**; identical worker containers on any host
**claim an account from the ERP's pool**, then **long-poll for the next city**
and search it the moment it is due. Managers add and remove cities in the ERP.
No message broker. Only the worker container stays Python (it runs the
vendored monitor); everything new is TypeScript inside the ERP.

The Python coordinator (`trackers/facebook/rs_coordinator`) **keeps** listing
dedupe, alert claims, Telegram, challenges and Messenger. Workers keep posting
listings to it. Its own city queue retires after cutover.

## Workstreams

| WS | File | Scope | Depends on | Parallel with |
| --- | --- | --- | --- | --- |
| A | [`WS-A-backend-core.md`](WS-A-backend-core.md) | Schema, auth scopes, cities/items/settings routes, scheduler, import | — | nothing until its schema PR merges; then everything |
| B | [`WS-B-claim-protocol.md`](WS-B-claim-protocol.md) | Slots, hosts, workers: `claim`, `heartbeat`, `next-task` long-poll, `events`, `session`, host `desired`/`report` | A (schema) | C, D, E, F |
| C | [`WS-C-worker-fleet-mode.md`](WS-C-worker-fleet-mode.md) | Worker image entrypoint + vendored monitor "fleet mode" | contract only | A, B, D, E, F |
| D | [`WS-D-fleet-agent.md`](WS-D-fleet-agent.md) | `apps/fleet-agent`: one TS container per host | contract only | A, B, C, E, F |
| E | [`WS-E-erp-ui.md`](WS-E-erp-ui.md) | Cities, Queue, Hosts, Slots tabs in the ERP frontend | contract only (mock server) | A, B, C, D, F |
| E2 | [`WS-E2-ui-rework.md`](WS-E2-ui-rework.md) | Rework the shipped tabs into the approved design ([`WS-E-ui-mock.html`](WS-E-ui-mock.html)): Fleet as one table with a Host column, Tasks with the belt, Analysis tab | E, A, B | C, D, F |
| F | Now section done; images on GHCR; Integration: login-free part done locally (#883); **MVP run done on `worker-60-14`** (2026-10-26 UTC): retired account #37, one login, two city-items searched against the dev ERP, worker left HEALTHY at capacity 1 | #876, #883, #891, #902, #903 | Cloudflare `FLEET_WORKER_ENV` (OpenRouter only), no coordinator, proxy `:10018`, facebook-tracker 0.14.1 (worker `User-Agent` for Cloudflare), agent 1.349.0; timings and surprises in `WS-F-ops-and-cutover.md` → *MVP run*. **Coordinator wired on dev (2026-10-26)**: forwarder `rs-coordinator-lan` (`10.10.10.73:8500`, admits only `10.10.60.14`), `FLEET_COORDINATOR_URL` set, per-worker tokens in `FLEET_WORKER_ENV` as `RS_CONTROL_PLANE_TOKENS`, worker image facebook-tracker 0.14.2 with alerts withheld until `RS_ALERTS=on` (after prod); it records logins only and does not speed a search (opening is the worker's own cache), see WS-F → *Coordinator wiring*. Open: stale-epoch/restart check (a second login), `RS_ALERTS=on` + Telegram after prod, pilot with live accounts (owner's yes) **Pilot on dev (2026-10-26)**: db-sync now keeps the dev fleet (#923, v1.359.0); four parked accounts, homelab containers stopped 10:31 UTC; the first worker (ca-3, #22) logged in once and hit Facebook's lock page, its slot was parked and capacity set to 0, so nj-1, bos-1 and nyc-3b never started (1 login, 0 tasks); host left observe-only, see WS-F → *Pilot on dev* |
| G | [`WS-G-tiers-second-host.md`](WS-G-tiers-second-host.md) | Tiers by alert hits, second host | cutover done | — |

```
A.schema ──► A.scheduler ──► B.claim ──┐
                                      ├──► integration (F) ──► cutover (F) ──► G
C.worker  (mock contract) ────────────┤
D.agent   (mock contract) ────────────┤
E.ui      (mock contract) ────────────┘
```

**Integration point.** When A, B and C are merged, F runs the end-to-end check
in [`WS-F-ops-and-cutover.md`](WS-F-ops-and-cutover.md) → *Integration*: one
real worker container against the dev ERP with a throwaway pool account. D and
E join as they land.

## Rules for every agent

1. **Contracts first.** [`CONTRACTS.md`](CONTRACTS.md) is the one source for
   table names, routes, payloads, error codes, env vars and image names. Build
   against it, mock what is not merged yet. If you need a change to it, open
   a PR that changes `CONTRACTS.md` *and* the code, and name the other
   workstreams it touches in the PR body. Do not change it silently.
2. **Own your files.** Each workstream lists the paths it owns. Edit another
   workstream's files only through its owner, or in a PR that names them.
   Shared files you may append to: `docs/DATABASE.md`, `docs/FEATURES.md`,
   `CHANGELOG.md`, `packages/shared/src/fleet.ts` (types; coordinate in the
   PR body), `apps/backend/src/routes/fleet.ts` (mount only; the handlers live
   in your own module).
3. **One session, one worktree, one branch** (`scripts/new-session.sh`).
   Branch off `origin/dev`, PR to `dev`, squash-merge. Rebase on `origin/dev`
   right before merging and re-check your migration number, root version and
   ticket number: other sessions take numbers too
   (`docs/agents/session-isolation.md`).
4. **Versions and changelog.** ERP code (`apps/`, `packages/`) bumps the root
   `package.json` minor and adds a `CHANGELOG.md` section in the same PR.
   Tracker code (`trackers/facebook/`) writes under `[Unreleased]` in its
   `CHANGELOG.md`; the release is cut by F.
5. **Never touch the live fleet.** No worker restart, re-login, deploy or
   config edit on `10.10.10.73` outside WS-F's cutover steps, and those each
   need the owner's yes. Every container start is a Facebook login (root
   `AGENTS.md`, first rule).
6. **Tests before the PR.** Backend `pnpm --filter recycle-erp-backend test`,
   frontend `pnpm --filter recycle-erp-frontend test`, `pnpm typecheck`;
   tracker suites per `trackers/facebook/AGENTS.md`. Postgres tests run on a
   throwaway database, never on 5432/55432.
7. **Secrets.** Nothing from `fb_pool_accounts`, `FB_POOL_KEY`, the
   coordinator vault or `secrets.env` goes into a commit, a test fixture or a
   PR body. Test with made-up accounts.
8. **Report back here.** When your PR merges, tick your exit criteria in your
   workstream file and update the status table below in the same PR.

## Owner decisions 2026-10-24

1. The throwaway account for the first real run is a **retired** pool account (dev's pool copy has its rows but no `*_enc` values; credentials exist only in prod's pool).
2. The first real-login run happens on the fleet host `worker@10.10.60.14` (approved).
3. The Python coordinator is left out of the MVP: fleet workers run without it (no listing dedupe, no alert claims, no challenge escalation) until it is wired back; `FLEET_COORDINATOR_URL` empty → `settings.coordinator_url: null`.
4. Images live in OCI's free tier: private OCIR repositories `<region-key>.ocir.io/<namespace>/{aimm-recycle,fleet-agent}`, built on the Mac and pushed, instead of GHCR private packages and a private GitHub mirror. **Amended 2026-10-25:** use GHCR while it works and push nothing to OCI. Images are private GHCR packages `ghcr.io/jinhuw/{aimm-recycle,fleet-agent}`, pushed from the Mac with the `gh` token; hosts pull with a `read:packages` PAT. The OCIR repositories stay empty as the fallback.
5. Shared worker secrets (`OPENROUTER_API_KEY`, Telegram, later the coordinator tokens) are the Cloudflare Worker secret `FLEET_WORKER_ENV`, added at the edge to a `200` claim answer as `env`; hosts use the Cloudflare hostname (`https://inventory-dev.recycleservers.com`, `https://inventory.recycleservers.com`) as `FLEET_URL`, never the Railway origin or `api.recycleservers.com` (not the ERP).
6. Host prep for `worker-60-14` ran read-only: Ubuntu 24.04.5 x86_64, 8 CPUs, 62 GB RAM, 94 GB free, Docker 29.9.2 cgroup v2, user in group `docker`, no containers, inventory-dev and api.dev answer 200, ghcr.io and iad.ocir.io reachable, `10.10.10.73:8500` closed, clock synchronised.
7. A worker that cannot connect (Facebook or its proxy unreachable, at boot or later) stops and waits for an operator: no retry loop, exit `78`, and the agent never restarts it (every restart is a login).

## Status

**Random extension (RS-422, 2026-10-27):** denver-1 (#10) restored its full
session in one boot and is HEALTHY as worker-60-14-4 on 0.14.10. Its exact
proxy, pinned browser header, 21 IndexedDB databases and 28,524-entry listing
cache were preserved. Legacy launch files are retired; other workers and
west-1's parked slot were unchanged. This remains a dev pilot with alerts off;
see [WS-H](WS-H-migration.md).

**Extension (RS-421, 2026-10-27):** wc-1b (#30) restored its complete
session in one boot and is HEALTHY as worker-60-14-1 on 0.14.10. west-1
(#15) is fully staged but parked because its unchanged proxy returns 503
from both hosts, before Facebook login. Its IP was not changed and no
browser retry was made. The parent cutover remains open. Details in
[WS-H](WS-H-migration.md).

**Latest live pilot (2026-10-27):** RS-419 / #940 preserved the complete
session before moving healthy ca-3 (#55) to the dev ERP fleet as
`worker-60-14-3`, worker 0.14.8 / ERP v1.367.1. One boot restored its session;
it is HEALTHY, with the same proxy and presented device and the listing cache
copied before startup. Legacy ca-3 is retired, other workers were untouched,
and alerts remain off on dev. See [WS-H](WS-H-migration.md) for the exact
checks, backups and first-search result. The earlier #22 lock belongs to a
different account and does not describe this handover.

| WS | Status | PR | Notes |
| --- | --- | --- | --- |
| A | A1 and A2 merged | #875, #880 | migration landed as `0206_fleet.sql` (0205 was taken); `GET /api/fleet/health` is manager scope; worker-token key derives from `JWT_SECRET` outside production. A2 (v1.338.0): catalog, tasks and round routes, `reconcile()` on a 30 s tick (`FLEET_ROLE=manager-only` skips it) and after every manager write, `fleet-import.mjs`; probe tasks carry their slot's `account_no` from insert; DELETE cancels waiting tasks only, a leased one finishes; `GET /items` and `GET /tasks` answer bare arrays, `GET /cities` answers `{cities}` |
| B | merged | #881, #885 | v1.339.0: `src/fleet/{claim,hosts,workers,vnc}.ts`; worker routes, hosts/desired/report, releases (roll state in `fleet_settings.release`), slots (plus `unpark`), workers, VNC relay; `fleet-seed-slots.mjs`, `fleet-fake-worker.mjs`; task ids cast to int on the wire; proved locally against a private DB with a made-up account. #885 (v1.342.0): `next-task` takes `take: false`, which closes `done` and leases nothing (`reason: "done_only"`), so a stopping worker's last task is not left leased; the fake worker's final report uses it |
| C | done (mock contract); integration gaps 1 and 3 merged; VNC relay client merged; MVP round (claim env, no coordinator, park on connect failure) merged | #879, #886, #887, #892 | `rs_worker/entry.py`, `deploy/Dockerfile.worker`, monitor `[fleet]` mode on `recycle-patches`; end-to-end against WS-B's backend is F's integration step. Second PR (monitor `9a06d98`, unreleased): a stopping worker sends its pending `done` with `take: false` (8 s, never on a stale epoch); entrypoint stops within `docker stop -t 30` (smoke: built image against the fake fleet, exit 0 in about 1 s); master.toml's `date_listed` list pinned by tests (it already worked). **VNC relay:** as §5 is written the worker cannot bridge RFB (the VNC server speaks first, a parked socket may not send, and nothing tells the worker a viewer arrived); the server sends a `viewer` text frame on pairing since #888 (v1.343.0), and #887 adds the worker's relay client (`rs_worker/vnc_relay.py`), which waits for it and then bridges x11vnc. **MVP round** (monitor `1bf74f7`, unreleased): the entrypoint exports the claim's `env` (strings only, key names logged once, never values; cannot set `RS_FLEET_*`, `RS_FB_*` and the like), drops every `${VAR}` still unset from the rendered config and exits 70 without `OPENROUTER_API_KEY`; with `settings.coordinator_url` empty no `control_plane_*`/`alert_report_*` key is rendered and `RS_CONTROL_PLANE_URL` is removed, so the monitor runs with no control plane (search, AI, Telegram only). A connect failure (Chromium `net::ERR_PROXY_*`/DNS/refused/timeouts, or any navigation failing after its tries) at boot or mid-task parks the worker for good: no `next-task`, no login, heartbeats `DEAD` `{reason: "connect_failed", operator: true, error}` every 5 min (lease kept), `/healthz` 200 `"state": "parked"`; stale epoch while parked or a park that cannot wait exits **78**. Smoke on the built image against the fake fleet with a non-resolving proxy: calls `claim` 1, `heartbeat` 2 (then a third at 5 min), no `next-task`; `docker stop -t 30` exit 0 in about 1 s |
| D | merged | #877 | v1.335.0; `apps/fleet-agent` with planner, docker CLI and agent tests, Dockerfile, README; live Docker check passed locally against a mock ERP; the check against the dev backend is F's integration step |
| E | merged | #878, #884 | v1.337.0: Cities, Queue, Hosts, Slots tabs + fleet worker page against mocks. v1.341.0: the tabs read the shapes A2/B shipped (bare arrays and bare cities, `open_tasks`, `{started, skipped}`, `{hosts, release}`, `parked` + Unpark, 409 `unverified` → Enable anyway); live check done **locally** against a private DB with a made-up account and `fleet-fake-worker.mjs`, not on Railway dev |
| E2 | done | #893 | v1.344.0: five approved tabs, merged account table, task belt and city-log aside, Analysis and Runs on; private-DB and browser verification, no Facebook login |
| F | Now section done; registry moved to OCIR (repos created, token blocked on the owner); Integration: login-free part done locally, real-login part waits for the owner | #876, #883, #891 | Images now in OCIR, private: `sin.ocir.io/ax6usa8hwbie/{aimm-recycle,fleet-agent}` (Pay-As-You-Go Singapore tenancy; the Always-Free Toronto one refuses OCIR with `FREE_TIER_NOT_SUPPORTED`); built and pushed from the Mac by `trackers/facebook/scripts/push-fleet-images.sh` (dry run built both for amd64); `fleet-images.yml` marked superseded. No auth token created and no `docker login` run: the tenancy's user already holds the maximum two (`terraform-backend`). Host prep for `worker-60-14` ran read-only 2026-10-24 (all within expected; output in WS-F). Hosts use `FLEET_URL=https://inventory-dev.recycleservers.com` (prod `inventory.recycleservers.com`); `api.recycleservers.com` is not the ERP. 4 `FLEET_*` vars set on Railway **dev** (`FLEET_IMAGE_WORKER`/`_AGENT` still name GHCR refs). Local integration (fake worker + agent with a sleeping image, no login) passed; it found the city-add wake bug, fixed in v1.340.0. Owner steps: free an auth token (or a pull-only user), throwaway pool account, coordinator wiring later |
| G | not started | | |
| platform | merged | #890 | Cloudflare Worker adds `FLEET_WORKER_ENV` to `200` claims as `env` (test `deploy/cloudflare/worker.test.mjs`, run in `deploy-frontend.yml`); `settings.coordinator_url` is `null` without a coordinator; agent leaves exit `78` stopped and reports `operator_needed`; CONTRACTS §1/§2/§5/§6/§10 for decisions 3, 4, 5, 7; `FLEET_URL` examples now the inventory hostnames. Worker side of `env` and parking landed in #892 |
| Review fixes | implemented and verified locally (RS-400) | | v1.349.0, migration 0207, PR #901; backend 2,708 tests, frontend 1,154, agent 50 + 3 Docker, worker 42; no real-worker deploy; see CLAUDE-REVIEW-HANDOFF.md |

## Facts an agent should not have to rediscover

- The ERP already holds the Facebook account pool: `fb_pool_accounts`
  (`apps/backend/migrations/0182_fb_pool.sql`) with `password_enc`,
  `totp_enc`, `cookie_enc`, `token_enc` sealed under `FB_POOL_KEY`
  (`apps/backend/src/lib/sealed.ts`: `seal`, `unseal`, `poolKey`). Stints and
  proxies: `fb_worker_accounts`, `fb_proxies` (`0204_fb_worker_accounts.sql`,
  `routes/facebookPool.ts`). Shared types: `packages/shared/src/facebookPool.ts`.
- The vendored monitor is `trackers/facebook/ai-marketplace-monitor/`, branch
  `recycle-patches`, pinned in `trackers/facebook/VENDOR.md` (cb6d09b, the
  fleet-mode commit, since 2026-10-24). It is gitignored; clone it from a checkout that has it
  (`docs/agents/...`, memory "facebook vendored monitor in worktrees").
  Queue code worth reading: `facebook.py` `queued_cities` (~2071),
  `search()` (~2700–2850), `monitor.py` `start_monitor` idle loop (~723–829),
  `_run_all_jobs`, the `sweep` directive (3a621a4).
- The current coordinator queue: `trackers/facebook/rs_coordinator/rs_coordinator/city_queue.py`
  (`pick`, `next_city`, leases), `routers/queue.py`, `routers/health.py`
  (heartbeat renews leases). The host-agent logic to port: `fleet.py`,
  `routers/fleet.py`, and `trackers/facebook/rs_fleetd/`.
- Live numbers on 2026-10-24: 41 accounts, 15 HEALTHY, 127 cities, 2 items,
  one city-item ≈ 4–7 browser minutes, so a full daily round ≈ 2 h per
  healthy account.
- Review findings on the old queue that this design fixes: unbounded lease
  renewal, quarantine with no exit, DEGRADED releasing a city mid-search, a
  held rule that skips home cities, 4xx answers triggering an own-list sweep.
