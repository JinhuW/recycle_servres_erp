# ERP fleet: an always-on city task queue for the Facebook workers

**Ticket:** RS-394 · **Spec:** [`../../specs/2026-10-24-erp-fleet-task-queue-design.md`](../../specs/2026-10-24-erp-fleet-task-queue-design.md) · **Owner:** jinhu · **Started:** 2026-10-24

This folder is the implementation plan, split so that several agents can work
it at once. Read this file, then [`CONTRACTS.md`](CONTRACTS.md), then your
workstream file.

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
| F | [`WS-F-ops-and-cutover.md`](WS-F-ops-and-cutover.md) | GHCR images, Railway env, host prep (`10.10.60.14`), imports, cutover runbook | A–E for cutover; host prep and CI now | A, B, C, D, E |
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

## Status

| WS | Status | PR | Notes |
| --- | --- | --- | --- |
| A | A1 merged; A2 not started | #875 | migration landed as `0206_fleet.sql` (0205 was taken); `GET /api/fleet/health` is manager scope; worker-token key derives from `JWT_SECRET` outside production |
| B | not started | | |
| C | done (mock contract) | #879 | `rs_worker/entry.py`, `deploy/Dockerfile.worker`, monitor `[fleet]` mode on `recycle-patches`; end-to-end against WS-B's backend is F's integration step |
| D | merged | #877 | v1.335.0; `apps/fleet-agent` with planner, docker CLI and agent tests, Dockerfile, README; live Docker check passed locally against a mock ERP; the check against the dev backend is F's integration step |
| E | not started | | |
| F | Now section done; Integration waits for A+B+C | #876 | `fleet-images.yml` on dev, both jobs skip until the mirror/private packages exist; 4 `FLEET_*` vars set on Railway **dev**; `HOSTS.md` has the owner-runnable checklist; export procedure in WS-F. Host `10.10.60.14` answered from the Mac at 21:30 UTC after being dark earlier; nothing run on it. Owner steps: mirror + `AIMM_MIRROR_*`, private GHCR packages + `GHCR_PRIVATE_CONFIRMED`, GHCR read token, coordinator LAN publish, first host command |
| G | not started | | |

## Facts an agent should not have to rediscover

- The ERP already holds the Facebook account pool: `fb_pool_accounts`
  (`apps/backend/migrations/0182_fb_pool.sql`) with `password_enc`,
  `totp_enc`, `cookie_enc`, `token_enc` sealed under `FB_POOL_KEY`
  (`apps/backend/src/lib/sealed.ts`: `seal`, `unseal`, `poolKey`). Stints and
  proxies: `fb_worker_accounts`, `fb_proxies` (`0204_fb_worker_accounts.sql`,
  `routes/facebookPool.ts`). Shared types: `packages/shared/src/facebookPool.ts`.
- The vendored monitor is `trackers/facebook/ai-marketplace-monitor/`, branch
  `recycle-patches`, pinned in `trackers/facebook/VENDOR.md` (3a621a4 on
  2026-10-24). It is gitignored; clone it from a checkout that has it
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
