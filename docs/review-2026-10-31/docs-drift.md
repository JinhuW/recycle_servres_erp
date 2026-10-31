# Documentation drift — review 2026-10-31

Lanes: C1 (Features vs code), C2 (Agent and ops docs), C3 (Project memory hygiene). 54 findings: 0 P1 / 8 P2 / 46 P3. Severity shown is after verification; P3s were not verified.

## P2

- [ ] **C1-04 / P2 / confirmed: Facebook README tells operators a connect_failed park ends only with docker stop (a new container = a Facebook login); 0.15.0 added Mark healthy / resume and timeout retries**
  - Location: `trackers/facebook/README.md:482-498 ("Only `docker stop` ends it" at :496), :465-468, :1324`
  - Evidence: README: timeouts 'raise ConnectFailedError at once' and 'Only `docker stop` ends it (exit 0)'. trackers/facebook/CHANGELOG.md 0.15.0 (RS-454): a timeout is retried twice more (10 s, 30 s) and a connect_failed park accepts the ERP's one-shot resume directive (Mark healthy, ERP v1.380.0); backend apps/backend/src/fleet/claim.ts:494-533 hands out resume. FEATURES.md 3690-3700 documents Mark healthy.
  - Failure: An operator with a worker parked on 'Page didn't load' follows the README and docker-stops it; the replacement container restores the session, i.e. a Facebook login the AGENTS.md first rule forbids, when Mark healthy would have resumed in the same browser.
  - Fix: At :496 replace 'Only `docker stop` ends it (exit 0).' with: '**Mark healthy** on the ERP Fleet page sends a one-shot `resume` heartbeat directive for a `connect_failed` park: the worker clears its parked state and asks for a task again in the same browser, with no login (0.15.0). `login_failed`, `browser_failed` and `crashed` parks ignore it. `docker stop` (exit 0) means a new container, which is a Facebook login.' Replace the timeout clause at ~:484 with: 'a timeout is tried twice more in the same page, 10 s and 30 s apart (0.15.0), before it raises ConnectFailedError'. At :465-468 change "an operator's `relogin` directive" to "an operator's `relogin` or, for `connect_failed`, `resume` directive".
  - Regression test: none (docs); optional grep check in CI
  - Verifier: trackers/facebook/README.md:496 'Only `docker stop` ends it' and :465-468 list only the relogin directive for a parked worker. trackers/facebook/CHANGELOG.md [0.15.0] adds the one-shot `resume` directive (Mark healthy, ERP 1.380.0) and timeout retries; the vendored monitor at the VENDOR.md pin 3576db7b handles it (src/ai_marketplace_monitor/facebook.py:2210-2218, tests/test_fleet_mode.py:1834); ERP side apps/backend/src/fleet/workers.ts:52-67 (resume_id). Live homelab runs aimm-recycle:0.15.0 (docker ps, read-only). (The README steers an operator to docker stop, which is a new container and therefore a Facebook login, when Mark healthy resumes in the same browser. Directly contradicts the repo's first rule: P2 stands.)

- [ ] **C1-05 / P2 / confirmed: Facebook README says to restart workers after editing search settings, contradicting the repo's first rule**
  - Location: `trackers/facebook/README.md:1208-1209`
  - Evidence: README: 'After editing, regenerate worker configs with `rsc gen-configs` and restart the workers.' AGENTS.md 'First rule': never restart a worker to pick up a setting; every restart is a login. configs/generated/ does not exist in trackers/facebook/configs (only homelab.toml template remains), and ERP fleet workers take settings from their claim.
  - Failure: An operator tuning search_interval follows the README and restarts the fleet: every worker logs in again, risking checkpoints (26 of 41 accounts were already parked on 2026-10-24).
  - Fix: Replace :1208-1209 with: 'ERP fleet workers read search settings from their claim and the Fleet Rules dialog; a change reaches each worker at its next task. Never restart a worker to pick up a setting: a restart is a Facebook login (see AGENTS.md).'
  - Regression test: none (docs); optional grep check in CI
  - Verifier: trackers/facebook/README.md:1208-1209: 'After editing, regenerate worker configs with `rsc gen-configs` and restart the workers.' AGENTS.md 'First rule' forbids restarting a worker to pick up a setting; FEATURES (search-to-alert Edit, v1.265.0) says saves reach workers between jobs. (A written instruction to restart the whole fleet, i.e. one login per worker. P2 stands.)

- [ ] **C1-06 / P2 / confirmed: Facebook README presents retired homelab compose workers, rs_fleetd and `rsc fleet release` as the live fleet; the ERP fleet (apps/fleet-agent, /api/fleet) is barely mentioned**
  - Location: `trackers/facebook/README.md:5-7, :37-78 ("Six workers divide the lower 48" :55), :251-300 (deploy steps), :339-382 (fleet agent / rolling releases), :386`
  - Evidence: Only configs/homelab.toml (template) remains; deploy/docker-compose.homelab*.yml are gone (ls trackers/facebook/deploy), so scripts/deploy.sh homelab_workers() (:78-85) yields nothing and it rebuilds coordinator+console only (:311,:367-371). trackers/facebook/CHANGELOG 0.14.8-0.14.14 retired/handed over every legacy launch. Live workers run under apps/fleet-agent (apps/fleet-agent/README.md) with releases via ERP /api/fleet/releases (apps/backend/src/routes/fleet.ts:152); README mentions this only as 'The ERP is growing a task queue' (:386). AGENTS.md lists `rsc fleet release` as a login. README never mentions apps/fleet-agent or scripts/push-fleet-images.sh.
  - Failure: A new operator or agent treats rs_fleetd / `rsc fleet release` as the upgrade path and runs it (every recreated worker logs in), or debugs region-pinned workers that no longer exist instead of the ERP fleet.
  - Fix: Insert after :59: 'Since facebook-tracker 0.14.14 no homelab compose worker remains. Workers run in the ERP fleet: `apps/fleet-agent` on each host starts identical `rs-worker-*` containers that claim an account and pull city tasks from the ERP (`/api/fleet`); images go out with `scripts/push-fleet-images.sh` and releases through the ERP Fleet tab. The region table below is fleet.toml's coverage template, not a deployment.' At the top of :339 add: 'Superseded for ERP fleet workers by apps/fleet-agent. rs_fleetd applies only where rs-fleetd still runs; every worker a release recreates is a Facebook login.' Replace the :251-300 step list with 'test, rebuild coordinator + console, verify; deploy.sh no longer touches workers (none are in compose) and ERP fleet workers are released from the ERP.'
  - Regression test: none (docs); optional grep check in CI
  - Verifier: Read-only `ssh 10.10.10.73 docker ps`: the homelab VM runs rs-fleet-agent (ghcr.io/jinhuw/fleet-agent:1.380.1) and rs-fleet-homelab-1..9 (aimm-recycle:0.15.0), plus coordinator/console; no compose region workers and no rs_fleetd agent. README.md:5-7, :55 ('statically pinned to one region'), :251-300 (scripts/deploy.sh restarts workers), :339-382 (rs_fleetd / rolling releases) present those as the live path. docs/tickets/RS-418 records 25 homelab workers retired on 2026-10-27. apps/fleet-agent is not named in the README (grep 'fleet-agent' -> 0 hits). (Overstated in one respect: the README does have a ~150-line 'Fleet mode' section on /api/fleet (:384-540), so the ERP fleet is not 'barely mentioned', though it is framed as 'growing' and the host agent is never named. The core claim holds: the deploy/upgrade instructions point at retired machinery whose scripts restart workers (logins). P2 stands.)

- [ ] **C1-07 / P2 / confirmed: Root README quick start signs in as marcus@ with 'any password', but the Docker image never seeds demo users**
  - Location: `README.md:79-81`
  - Evidence: README: 'Sign in with `marcus@recycleservers.io` and any password (dev image ships with ENABLE_DEMO_ACCOUNTS=true)'. apps/backend/Dockerfile:68 CMD runs migrate.mjs and init-admin.mjs only, never seed. ENABLE_DEMO_ACCOUNTS only enables GET /api/auth/demo-accounts (routes/auth.ts:105-115), which lists users, it does not create them or waive passwords; seeded users use password 'demo' (apps/backend/scripts/seed.mjs:414,738).
  - Failure: A new developer runs `docker compose up`, tries the documented login and gets refused; the first step of onboarding fails.
  - Fix: Replace :79-81 with: 'Sign in with the admin created by `init-admin.mjs` (`ADMIN_EMAIL` / `ADMIN_PASSWORD`, see .env.example). For the demo users run `docker compose exec backend node ./scripts/seed.mjs` and sign in as `marcus@recycleservers.io` with password `demo`.'
  - Regression test: none (docs); optional grep check in CI
  - Verifier: Replayed the backend image CMD (apps/backend/Dockerfile: migrate.mjs && init-admin.mjs) with the Dockerfile ENV defaults on a disposable PG18: SELECT email, role FROM users -> 1 row, admin@recycle.local / manager (repro/C1-verify/C1-07-image-boot.txt). marcus@ comes only from scripts/seed.mjs, which the image never runs, and seed passwords are 'demo' (seed.mjs:414), not 'any password'; ENABLE_DEMO_ACCOUNTS only gates GET /api/auth/demo-accounts (routes/auth.ts:112-114). Login checks bcrypt (auth.ts verifyPassword). (The documented first login fails on a fresh `docker compose up`; the working credential (admin@recycle.local / admin) is not in the quick start. P2 (supported onboarding flow broken).)

- [ ] **C1-08 / P2 / confirmed: Root README relies on a docker-compose.override.yml that is gitignored and absent, so the documented host-side db:migrate cannot reach Postgres**
  - Location: `README.md:21, :94-101`
  - Evidence: README :21 lists docker-compose.override.yml in the layout as re-publishing Postgres; .gitignore:56 ignores it and it is not in the tree. docker-compose.yml:12-13 publishes no host port for postgres.
  - Failure: On a fresh clone, `pnpm db:migrate` / `pnpm dev` against localhost:5432 (README :94-101) fails with connection refused.
  - Fix: Replace :21 with '`docker-compose.override.yml` (not committed; create locally): re-publishes Postgres on 127.0.0.1:5432' and before :94 add the file body: `services:\n  postgres:\n    ports: ["127.0.0.1:5432:5432"]`.
  - Regression test: none (docs); optional grep check in CI
  - Verifier: docker-compose.override.yml is gitignored (.gitignore:56, git check-ignore) and absent from the tree (git ls-files has none); docker-compose.yml's postgres service publishes no host port ('No host port' comment). README.md:94-101 runs `docker compose up -d postgres` then `pnpm db:migrate` against localhost and only mentions the override as existing, never how to create it. (On a fresh clone the host-side loop cannot reach Postgres. Not run end to end (would need the user's compose stack), but the absence of any published port is deterministic from the files. P2 stands.)

- [ ] **C1-10 / P2 / confirmed: Reddit README's local api command defaults to the Telegram transport and can take production's bot getUpdates**
  - Location: `trackers/reddit/README.md:201`
  - Evidence: README: `ROLE=api API_TOKEN=devtoken pnpm dev`. trackers/reddit/src/config.ts:71 makes ALERT_TRANSPORT default to 'telegram' unless 'console'; .env.example does not set it; with the bot token in .env the api starts the reactions loop (src/index.ts:94) and calls getUpdates. README :359-362 itself warns two pollers steal each other's updates.
  - Failure: A developer runs the documented command with a real .env: the local api consumes production's Telegram updates (reactions/labels lost from prod) and may run the user-session sender.
  - Fix: Replace :201 with: `ALERT_TRANSPORT=console ROLE=api API_TOKEN=devtoken pnpm dev # admin API on :8080; console keeps it off prod's bot updates`
  - Regression test: none (docs); optional grep check in CI
  - Verifier: trackers/reddit/README.md:201 `ROLE=api API_TOKEN=devtoken pnpm dev` sets no ALERT_TRANSPORT; src/config.ts:70-71 defaults to 'telegram'; src/index.ts:94-106 starts the getUpdates reactions loop whenever transport is telegram. Offline repro: loadConfig() with the README env plus a dummy bot token -> {role:'api', alertTransport:'telegram', reactionsLoopStarts:true} (repro/C1-verify/C1-10-reddit-api-transport.txt). The local offset starts from a fresh telegram_state, so a poll with the prod token acknowledges prod's pending updates (reactions.ts:85-90). .env.example has a single TELEGRAM_BOT_TOKEN slot; src/loops/reactions.ts:4-7 says only the telegram transport should poll 'so a local api never takes production's updates'. (Not exercised against Telegram (that would need the prod token, a forbidden action); the impact depends on the developer's .env holding the production bot token, which the .env.example invites. The user-session sender part needs TELEGRAM_USER_SESSION too, so it is less likely. P2 stands.)

- [ ] **C2-01 / P2 / confirmed: [cross-lane] Root AGENTS.md map and its Facebook-login rule omit the ERP fleet (apps/fleet-agent, apps/backend/src/fleet, /api/fleet), which now runs the live Facebook workers**
  - Location: `AGENTS.md:22-31 (First rule), AGENTS.md:43-50 (Map); trackers/facebook/AGENTS.md:113-122`
  - Evidence: apps/fleet-agent/ (README, Dockerfile, src/) exists and is in no row of the Map table; nothing in AGENTS.md or docs/agents/ names it (grep 'fleet-agent' finds none). apps/fleet-agent/README.md:58,81,114 say every worker start is a Facebook login, and the agent starts, replaces and removes workers based on ERP state (/api/fleet/hosts desired.count, /api/fleet/releases). apps/backend/src/fleet/workers.ts:338 adds POST /api/fleet/workers/:id/relogin, and workers.ts:213-308 adds slot remove/retire/park/unpark. trackers/facebook/CHANGELOG.md 0.15.0 'Removed' retired the 25 unhealthy legacy workers on 2026-10-27; B3 notes say all 41 legacy roster workers are retired and the homelab now runs 9 rs-fleet-homelab containers under rs-fleet-agent. B3-01 counts 31 boot logins in 24 h, 20 ending challenged, locked or failed, driven by fleet count changes. AGENTS.md:22-31 lists only docker restart/compose/deploy.sh/rsc fleet release, coordinator relogin (/v1/workers/{id}/relogin) and session files. trackers/facebook/AGENTS.md:113-122 still says deploy.sh 'restarts the workers'.
  - Failure: An agent asked to 'get more workers running' or 'roll the new worker image' follows the documented rule, sees nothing about the ERP Hosts tab, host capacity, POST /api/fleet/releases or the fleet-agent, and changes a host count or starts a release. Each start or replacement is a boot login (B3-01: 20 of 31 in a day were challenged or locked), and the account can be lost. The Map also gives no AGENTS.md entry point for apps/fleet-agent, so its own login traps (docker rm rs-fleet-*, FLEET_STAGGER_SECONDS) are never read.
  - Fix: AGENTS.md:22, after the 'Starting a worker container' bullet, add: "- **Anything that makes the ERP fleet start a worker.** The fleet-agent (`apps/fleet-agent/`, one `rs-fleet-agent` container per host) starts, replaces and removes `rs-fleet-*` workers to match the ERP. So raising or lowering a host's capacity or `authoritative` flag (Monitors ▸ Facebook ▸ Hosts, `/api/fleet/hosts`), a release (`POST /api/fleet/releases`), a slot unpark/resume, `POST /api/fleet/workers/{id}/relogin`, and `docker rm rs-fleet-<id>` on a host are each a login." AGENTS.md Map: add the row "| `apps/fleet-agent/` | Fleet host agent: runs the ERP fleet's Facebook worker containers on each Docker host | TypeScript, Node 24, docker CLI | homelab `10.10.10.73` and `worker@10.10.60.14`, image `ghcr.io/jinhuw/fleet-agent:<root version>` | root | [apps/fleet-agent/README.md](apps/fleet-agent/README.md) |", and change row 50 to "... + the legacy coordinator fleet (workers retired 2026-10-27; live workers belong to the ERP fleet)". trackers/facebook/AGENTS.md:113: add "The legacy compose workers were retired on 2026-10-27; live workers are the ERP fleet's (`apps/fleet-agent/`)."
  - Regression test: docs-lint: a test that fails when a top-level directory under apps/ or trackers/ has no row in the AGENTS.md Map table.
  - Verifier: repro/C2-verify/checks.sh (output in checks.out): grep for fleet-agent|/api/fleet|apps/fleet in AGENTS.md, apps/backend/AGENTS.md and trackers/facebook/AGENTS.md returns nothing; apps/fleet-agent/ has no AGENTS.md or CLAUDE.md. The AGENTS.md:15-39 first rule lists only docker restart/compose, deploy.sh, rsc fleet release, /relogin and configs/sessions. The Map (AGENTS.md:43-50) has no apps/fleet-agent row. Yet apps/fleet-agent/README.md:3-8,58,108,114 says the agent starts, restarts and replaces Facebook workers to the ERP's desired count, that every start is a Facebook login (FLEET_STAGGER_SECONDS), and that `docker rm rs-fleet-*` brings a held worker back. apps/backend/src/routes/fleet.ts:151-152 mounts /hosts and /releases. (The login rule and the Map really omit the ERP-driven fleet path. Its login traps are written down only in apps/fleet-agent/README.md, and no agent doc points there. P2 fits: this is doc drift in an area the repo itself ranks as its top risk.)

- [ ] **C2-02 / P2 / confirmed: [cross-lane] The rs_console contract docs miss facebookPool.ts, the ERP caller that seeds sessions and triggers restore or re-login**
  - Location: `AGENTS.md:72; trackers/facebook/AGENTS.md:45-77`
  - Evidence: apps/backend/src/routes/facebookPool.ts:32 imports callFacade from ./coordinator. It calls GET /v1/fleet (:538), PUT /v1/accounts/{id} (:656), PUT /v1/workers/{id}/session (:680), POST /v1/workers/{id}/restore-session (:689), POST /v1/workers/{id}/relogin (:694) and GET /v1/logins (:836). rs_console serves PUT /v1/workers/{worker_id}/session (rs_console/rs_console/app.py:360) and POST /v1/workers/{worker_id}/restore-session (app.py:281), plus POST /v1/vnc/{id}/ticket, which vncBridge.ts:120 uses. trackers/facebook/AGENTS.md:45-77 lists every other route but none of these three. AGENTS.md:72 names only routes/coordinator.ts, vncBridge.ts and fleet/proxyHealth.ts as the ERP side.
  - Failure: Someone reshapes or tightens /v1/workers/{id}/session or restore-session on the console side while trusting the 'Forwarded today' list. The Pool Assign flow then breaks: cookie-first Assign falls back to POST /relogin (facebookPool.ts:694), a password login, on every assign. Or the endpoints are removed as unused. A reviewer checking the contract test also misses that facebookPool.ts has no row.
  - Fix: AGENTS.md:72 first cell: append ", and the account pool's Assign / credential / ledger calls in `routes/facebookPool.ts`"; Test cell: append ", `apps/backend/tests/facebook-pool*.test.ts`" (whichever covers Assign). trackers/facebook/AGENTS.md:57, after the relogin bullet, add: "- `PUT /v1/workers/{id}/session` (`{cookie, reason}`: seal a pool account's cookie as the worker's restorable session) and `POST /v1/workers/{id}/restore-session` (restore it, the gentle Re-login); both come from the ERP's Pool Assign (`routes/facebookPool.ts`). A restore is a login." and "- `POST /v1/vnc/{id}/ticket` (single-use ticket for the VNC websocket, `vncBridge.ts`)."
  - Regression test: Contract test that greps every callFacade(...) path in apps/backend/src and asserts each appears in trackers/facebook/AGENTS.md 'Forwarded today'.
  - Verifier: apps/backend/src/routes/facebookPool.ts:680 calls PUT /v1/workers/{id}/session through callFacade, :689 calls POST /v1/workers/{id}/restore-session, and :694 calls POST /relogin. Lines 681-687 treat any 4xx from the seed (a console without the route answers 404) as mode='password', so the Assign falls back to a password Re-login. rs_console serves both routes (trackers/facebook/rs_console/rs_console/app.py:281 and :360). The 'Forwarded today' list in trackers/facebook/AGENTS.md:45-77 and the contract row at AGENTS.md:72 mention neither route nor facebookPool.ts (grep in checks.out). Coverage exists only in apps/backend/tests/facebook-pool.test.ts, which the contract row does not cite. (The contract docs are incomplete in exactly the way claimed. If the console drops or reshapes those routes, every assign silently degrades into a password login, which the code itself confirms. Severity stays P2.)

## P3

- [ ] **C1-01 / P3 (raised as P2) / confirmed: FEATURES says managers can reassign a PO's purchaser until Done; code freezes ownership at Ready to Pay**
  - Location: `docs/FEATURES.md:108`
  - Evidence: Doc: 'Managers can reassign a PO's purchaser until it is Done (v1.84.0)'. apps/backend/src/routes/orders/patch.ts:366-388 lists body.onBehalfOfUserId among closed-book fields and throws OrderRefusal doneLocked once isClosedBook(lifecycle) (Ready to Pay or Done). The doc contradicts its own line 359 ('ownership freeze' at Ready to Pay).
  - Failure: A manager or agent reading FEATURES tries to move a Ready-to-Pay PO to another purchaser (e.g. to fix commission attribution) and gets doneLocked; an agent writing a fix/test from FEATURES encodes the wrong rule.
  - Fix: Replace line 108 with: 'Managers can reassign a PO's purchaser until it reaches Ready to Pay, when ownership freezes with the closed book (v1.84.0; re-open to Reviewing to change it) and submit'
  - Regression test: none (docs); optional grep check in CI
  - Verifier: docs/FEATURES.md:108 says 'Managers can reassign a PO's purchaser until it is Done'; apps/backend/src/routes/orders/patch.ts:366-389 throws doneLocked for body.onBehalfOfUserId when isClosedBook(lifecycle) (REVIEWED_LIFECYCLES = ['ready_to_pay','done'], services/orderAdvance.ts:50). Repro: TEST_DATABASE_URL=...:55731 npx vitest run tests/orders-ready-to-pay.test.ts -t ownership -> 1 passed; the manager PATCH onBehalfOfUserId at Ready to Pay returns 409 'Order is Ready to Pay or Done and cannot be modified' (repro/C1-verify/C1-01-ready-to-pay-reassign.txt). (The doc line is wrong, but FEATURES itself states the correct rule at :358 ('ownership freeze' at Ready to Pay), and the code fails safe with a clear 409. Self-contradictory doc, no data risk: P3.)

- [ ] **C1-02 / P3 (raised as P2) / confirmed: FEATURES describes the coordinator Fleet tab as it was before v1.344.0 (legend Live/Stale/..., Searches/Posts/Proxy columns)**
  - Location: `docs/FEATURES.md:3083-3125`
  - Evidence: Doc: 'Since v1.263.0 the Fleet tab shares the Account pool tab's chrome: a status legend (Live, Stale, Needs attention, Offline)... Today... Searches... Posts... at most 15 workers... A Proxy column'. apps/frontend/src/pages/desktop/fleet/FleetPage.tsx:24 renders FleetAccountsTab for /fleet (host cards + Worker/Host/Account/State/Now/Today/Lease/Version, legend All/Healthy/Free/Parked, FleetAccountsTab.tsx:42-47,158-166). FleetLegend and WorkersCard in pages/desktop/FleetWorkers.tsx:53,74 are exported but imported nowhere (grep). The same doc already describes the real tab at 3494ff, so the file contradicts itself.
  - Failure: A manager/agent following 3083-3125 looks for a Live/Stale legend, a Posts column or a per-row Proxy column that no longer exist, and the two contradictory descriptions make the doc untrustworthy for the fleet, where a wrong action can mean a Facebook login.
  - Fix: Replace the start of the bullet at 3083 with: 'Since v1.344.0 (RS-394) the Fleet tab is a strip of host cards over one table of every worker (the ERP fleet's and, until cutover, the coordinator's, host "homelab"): Worker, Host, Account, State, Now, Today, Lease, Version, narrowed by an All / Healthy / Free / Parked legend, a host select and search; see Fleet (ERP-owned) below. The Recent activity aside stays under the table while coordinator rows exist.' and prefix the v1.263-v1.309 column details with 'From v1.263.0 until v1.344.0'.
  - Regression test: none (docs); optional grep check in CI
  - Verifier: docs/FEATURES.md:3083-3125 describes the Fleet tab with a Live/Stale/Needs attention/Offline legend, Searches/Posts columns and a per-row Proxy column. The Fleet tab now renders fleet/FleetPage.tsx -> FleetAccountsTab (DesktopCoordinator.tsx:27,133); FleetLegend and FleetWorkers.WorkersCard (pages/desktop/FleetWorkers.tsx:53,74) have no importers (grep: only ActivityAside, eventDetail, statusNote, ProxyDeadChip are imported). FEATURES:3481-3500 describes the v1.344.0 replacement. (Stale description of components that are no longer rendered. The current behaviour is documented later in the same file and the stale text prescribes no login-causing action, so the harm is confusion, not a bad operation: P3.)

- [ ] **C1-03 / P3 (raised as P2) / confirmed: FEATURES documents 'Today's round', 'Start the round now' and 'Move every worker to the queue' on the coordinator Fleet tab, but RoundCard is no longer rendered**
  - Location: `docs/FEATURES.md:3301-3368`
  - Evidence: Doc 3301: 'Since v1.328.0 (RS-379) the Fleet tab opens with Today's round...'; 3329-3349 Start the round now / Move every worker to the queue; 3368 'On the round card, a city's name...'. RoundCard (apps/frontend/src/pages/desktop/FleetQueue.tsx:67) is exported and imported nowhere (grep across apps/frontend/src); /fleet renders FleetAccountsTab (fleet/FleetPage.tsx:24). The ERP fleet's own 'Start the round now' lives on the Tasks tab (FEATURES 3646).
  - Failure: An operator looks for the bulk 'Move every worker to the queue' or the round board on the Fleet tab and cannot find it, or an agent adds behaviour to dead RoundCard code believing it is live.
  - Fix: Prefix line 3301 with 'From v1.328.0 until v1.344.0 (RS-394)' and add after the block: 'Since v1.344.0 the round board, its Start the round now and the bulk move are not shown; a coordinator worker's page keeps its City queue row, Move to the queue / Back to its own list and City log card. The ERP fleet's own Start the round now is on the Tasks tab.' [cross-lane: RoundCard, FleetLegend and WorkersCard in FleetWorkers.tsx are dead code for the frontend lane]
  - Regression test: none (docs); optional grep check in CI
  - Verifier: RoundCard is defined at apps/frontend/src/pages/desktop/FleetQueue.tsx:67 and referenced nowhere else (grep -rn RoundCard apps/frontend/src -> only the definition); 'Move every worker to the queue' (fbcQueueEveryone) is used only inside RoundCard (FleetQueue.tsx:109). FEATURES:3301-3341 still presents Today's round and the bulk move on the Fleet tab. (Partly overstated: 'Start the round now' still exists, moved to the Tasks tab (fleet/FleetTasksTab.tsx:92, fleetRoundStart), so only its location is wrong; the round board and the bulk queue move are gone. Doc drift with dead code, no unsafe instruction: P3.)

- [ ] **C1-09 / P3 (raised as P2) / confirmed: Root README says production is single-host Docker Compose behind Caddy; it runs on Railway + Cloudflare Workers**
  - Location: `README.md:37-69, :252-278`
  - Evidence: README 'Production deploy' describes compose + Caddy. AGENTS.md Map and docs/agents/erp-ops.md:77-91: backend on Railway recycle-erp-experiment, SPA on Cloudflare Workers recycle-erp-prod/-dev, deployed by pushes to main/dev (deploy/cloudflare/deploy.sh, .github/workflows/deploy-frontend.yml).
  - Failure: Someone handling an incident or a release follows the README and looks for a compose host / Caddy config that is not production, or deploys a parallel stack.
  - Fix: Rename the section at :252 to 'Self-hosted Compose deploy' and insert before it: '**Production** runs the backend on Railway (`recycle-erp-experiment` → `backend`) and the SPA on Cloudflare Workers (`recycle-erp-prod`, `recycle-erp-dev`); pushes to `main` / `dev` deploy them. See docs/agents/erp-ops.md.' Adjust the Stack 'Edge' line (:37-69) the same way.
  - Regression test: none (docs); optional grep check in CI
  - Verifier: README.md:252-266 'Production deploy: Single-host Docker Compose' and :60-74 Caddy architecture; AGENTS.md Map: backend on Railway recycle-erp-experiment, frontend on Cloudflare Workers recycle-erp-prod/-dev; deploy/ has cloudflare/, railway-*; docs/agents/erp-ops.md documents Railway/Workers. README itself names Railway Postgres (:42) and the Railway backup cron (:271). (Wrong, but the operational docs agents and owners are directed to (AGENTS.md, erp-ops.md) are correct, and the README already mentions Railway in two places, so misdirecting a real release or incident is unlikely. Drift, not a trap: P3.)

- [ ] **C1-11 / P3 / P3, not verified: FEATURES says the fleet Analysis tab sums searches per UTC day; since v1.390.0 it buckets by Eastern day**
  - Location: `docs/FEATURES.md:3657`
  - Evidence: Doc: 'sums the ERP fleet's finished searches per UTC day'. apps/backend/src/fleet/tasks.ts:109,124 bucket by done_at AT TIME ZONE FLEET_TZ; CHANGELOG 1.390.0 (RS-473); the doc's own :3490 says Analysis uses Eastern days.
  - Failure: A manager comparing the funnel with Telegram counts trusts the wrong day boundary (8 PM ET).
  - Fix: Replace 'per UTC day' with 'per Eastern day (FLEET_TZ; UTC days before v1.390.0)'.
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-12 / P3 / P3, not verified: [cross-lane] Fleet Tasks 'Today (ET)' range actually starts at UTC midnight**
  - Location: `apps/frontend/src/pages/desktop/fleet/FleetTasksTab.tsx:43-44; apps/frontend/src/lib/i18n.tsx:5139; docs/FEATURES.md:3611`
  - Evidence: sinceFor('today') returns `toISOString().slice(0,10)+'T00:00:00.000Z'` (UTC midnight) while the option label is 'Today (ET)'. FEATURES :3611 correctly says 'today UTC'. Also fleetBoard.ts:41-44,159-160 averages task length from utcDayStart, while FEATURES :3607 says 'today's finished searches'.
  - Failure: After 8 PM Eastern the 'Today (ET)' table shows only tasks since 8 PM and drops the day's earlier searches; before 8 PM it starts at 8 PM yesterday.
  - Fix: Code (frontend lane): compute Eastern midnight with FLEET_TZ like the backend funnel, then change FEATURES :3611 to 'today (Eastern)'. Until then change FEATURES :3607 'the mean of today's finished searches' to 'the mean of the finished searches since midnight UTC'.
  - Regression test: frontend unit test: sinceFor('today', 2026-10-31T01:00Z) returns 2026-10-30T04:00Z (EDT midnight)

- [ ] **C1-13 / P3 / P3, not verified: FEATURES says OCR provider selection is silent and prod quietly stubs; production refuses to boot without the key**
  - Location: `docs/FEATURES.md:4172-4174`
  - Evidence: Doc: 'Provider selection is silent... A prod deploy missing the key looks healthy and quietly stubs.' apps/backend/src/env.ts:52-53 throws 'OPENROUTER_API_KEY is required in production'; ai/index.ts:23-30 logs a one-time WARN outside prod.
  - Failure: An operator debugging canned OCR in prod chases a 'silent stub' that cannot happen, or skips the boot error as unrelated.
  - Fix: Replace with: '> OpenRouter when `OPENROUTER_API_KEY` is set, otherwise a deterministic stub with a one-time warning. Production refuses to boot without the key, because the stub returns canned readings.'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-14 / P3 / P3, not verified: FEATURES Reddit page still says alert rules are edited under Evaluate (removed in v1.386.0)**
  - Location: `docs/FEATURES.md:2896-2897`
  - Evidence: Doc: 'Subreddits are edited under Poll and alert rules under Evaluate.' DesktopTracker.tsx:679,707 renders read-only LivePromptPanel; no rule create/update/delete call exists in apps/frontend/src. FEATURES :2910 already says so.
  - Failure: A manager looks for the rule editor that was removed.
  - Fix: Replace with: 'Subreddits are edited under Poll; alert rules were edited under Evaluate until v1.386.0 (see below).'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-15 / P3 / P3, not verified: FEATURES says Monitors ▸ Facebook is managers only; purchasers reach it for the Account pool**
  - Location: `docs/FEATURES.md:3083`
  - Evidence: apps/frontend/src/lib/desktopNav.ts:74 roles ['manager','purchaser']; DesktopCoordinator.tsx:28-35 shows purchasers the Account pool tab only.
  - Failure: Role docs understate purchaser access to the pool page.
  - Fix: Replace 'in the sidebar (v1.207.0), managers only.' with 'in the sidebar (v1.207.0); the fleet tabs are managers only, purchasers see the Account pool tab alone.'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-16 / P3 / P3, not verified: FEATURES role list for purchasers is stale (Shipping off the sidebar; Leads and Account pool missing)**
  - Location: `docs/FEATURES.md:42-43`
  - Evidence: desktopNav.ts:34-81: Shipping has no purchaser nav entry (comment :38-39, URL-only); Leads ▸ Reddit (:46) and Monitors ▸ Facebook pool (:74) are open to purchasers.
  - Failure: Readers mis-scope purchaser access when reviewing role gates.
  - Fix: Replace the list with: 'Home, Analysis, submit, history, clients, Leads (Reddit), market, the Facebook account pool under Monitors, settings (Shipping still resolves by URL but is off the sidebar) — and their own POs.'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-17 / P3 / P3, not verified: FEATURES CSRF exemption list omits the bearer-only and OAuth surfaces (same drift in README)**
  - Location: `docs/FEATURES.md:104-107; README.md:110-113`
  - Evidence: apps/backend/src/csrf.ts:18-29 also exempts /api/fleet/worker/*, fleet host report|stopped|tickets, /api/mcp, /api/market/values, /api/wechat-market/push/*, /oauth/*, /.well-known/*.
  - Failure: A security reviewer relying on the doc misses exempted routes when auditing CSRF.
  - Fix: Replace with: 'Exempt: safe methods, `/api/health`, `/api/public/*`, the bearer-only surfaces (`/api/fleet/worker/*`, fleet host reports, `/api/wechat-market/push/*`, `/api/market/values`, `/api/mcp`) and the OAuth surfaces (`/oauth/*`, `/.well-known/*`).'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-18 / P3 / P3, not verified: FEATURES purchaser Analysis claim says Done POs only; code counts Ready to Pay or Done**
  - Location: `docs/FEATURES.md:2810`
  - Evidence: apps/backend/src/routes/dashboard.ts:41-44,58-59 filter REVIEWED_LIFECYCLES = ['ready_to_pay','done'] (services/orderAdvance.ts:50).
  - Failure: A purchaser's projected profit includes POs not yet paid; doc readers misread the number.
  - Fix: Replace with: 'Purchasers see projected profit from their own POs at Ready to Pay or Done (v0.1.10).'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-19 / P3 / P3, not verified: FEATURES UI labels drifted from i18n strings**
  - Location: `docs/FEATURES.md:70, :904, :984-985, :1899`
  - Evidence: :70 'Hide pending' → i18n.tsx:3332 'Hide in sell orders'; :904 'Company | $1,279 / Self | $2,829' → orderPresentation.ts:190-195 'Business' or payer name (since v1.317.0); :984 'Follow line total' → i18n.tsx:2498 'Follow product total'; :1899 'Apply n to the order' → i18n.tsx:3489 'Apply {n} counts to the order'.
  - Failure: Users and testers search the UI for labels that don't exist.
  - Fix: :70 '*Hide in sell orders* filter'; :904 'a manager reads `Business | $1,279` or `‹payer name› | $2,829`'; :984 '**Follow product total** button'; :1899 '**Apply n counts to the order**'.
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-20 / P3 / P3, not verified: FEATURES PO list text still mentions KPI tiles and Payment filter chips, both gone**
  - Location: `docs/FEATURES.md:818, :1177-1178`
  - Evidence: :1177 'the KPI tiles stay in one row while four fit' — tiles removed v1.147.2 (doc :315), none rendered in DesktopOrders.tsx; sentence also breaks mid-thought. :818 'its filter chips read Business' — Payment filter is a dropdown since v1.394.0 (DesktopOrders.tsx:594-595; doc :1121).
  - Failure: Contradictory layout description of the PO list.
  - Fix: :1177-1178 'Under 1100px the list's toolbar wraps inside its card with the search box giving up width first. The edit page is one column…'; :818 'The list's Payment cell and its Payment filter options read *Business* or the person's name'.
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-21 / P3 / P3, not verified: FEATURES other small factual drifts (Shipping tab, Buyer network cap, Activity date range, Proxies Down rule, task list cap, client-errors stream, health providers)**
  - Location: `docs/FEATURES.md:2117, :1288, :2741, :3705, :3687-3689, :4302-4303, :2103`
  - Evidence: :2117 managers' mobile Shipping tab — PhTabBar.tsx:30-36 has none; :1288 'top 50 buyers' — redditLeads.ts:143-150 no LIMIT; :2741 'date range' — DesktopActivity.tsx:242-247 last-N-days, activity.ts:60 only `since`; :3705 Down 'two misses in a row' — shared/fleet.ts:376-380 also a first-ever miss; :3687 'capped at 1000 rows' — tasks.ts:28 HISTORY_LIMIT 5000 for done reads; :4302 'to stdout' — clientErrors.ts:101-120 log.warn (stderr) plus ERROR_LOG_DIR/errors.jsonl; :2103 'providers.tracking only' — index.ts:248-252 also ocr/mail/attachments.
  - Failure: Minor misinformation when operating or debugging these surfaces.
  - Fix: :2117 'Mobile label scan: look up, note, create a PO (v1.95.0; the managers' Shipping tab left the tab bar in v1.142.0).' :1288 'lists the top buyers from the latest harvest, most buys first.' :2741 'a last-N-days window'. :3705 '**Down** (two misses in a row, or a miss with no earlier check)'. :3687 'capped at 5000 rows'. :4302 'writes one greppable JSON line to stderr (and to `ERROR_LOG_DIR/errors.jsonl` when set)'. :2103 '`/api/health` reports only `providers.tracking` for shipping (no label provider).'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-22 / P3 / P3, not verified: FEATURES auth section omits credential_version (migration 0177), the mechanism that now revokes tokens**
  - Location: `docs/FEATURES.md:93-95`
  - Evidence: migrations/0177_users_credential_version.sql; auth.ts:75,99,140 put `cv` in tokens and refuse older versions; doc only describes tokens_valid_after.
  - Failure: A reviewer auditing session revocation reasons from the legacy mechanism.
  - Fix: Append: 'Since migration 0177 every credential change also bumps `users.credential_version`; a token carrying an older `cv` is refused, which closes the same-second gap `tokens_valid_after` left.'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-23 / P3 / P3, not verified: FEATURES MCP/OAuth section names wechat:write as the only service-only scope; fleet:read is one too**
  - Location: `docs/FEATURES.md:3973-3975`
  - Evidence: apps/backend/src/oauth/server.ts:19-24 SERVICE_ONLY = {'wechat:write','fleet:read'}.
  - Failure: A reviewer misses that self-registration also must never grant fleet:read.
  - Fix: Append: '`fleet:read` is the same kind of service-only scope, held by the dev ERP's client that reads prod's fleet; registration never grants either.'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-24 / P3 / P3, not verified: Shipped CHANGELOG behaviour FEATURES never mentions: v1.393.1 pool cookie limit, v1.353.0 coordinator response cache**
  - Location: `docs/FEATURES.md:3794 (Account pool editor), :3083ff (coordinator); CHANGELOG.md:57-70, [1.353.0]`
  - Evidence: Scripted check of every CHANGELOG section >=1.300.0 with Added/Changed against FEATURES version citations: only 1.352.0 (agent internals), 1.353.0 and 1.359.0 (prod->dev sync, ops doc) are uncited; all versions 1.384-1.395 are cited. Fix-only 1.393.1 (RS-480: 8,000-char cookie limit only for changed cookies, packages/shared/src/facebookPool.ts:133) is user-visible and absent (grep RS-480/8000 in FEATURES: none). 1.353.0 cache (coordinator.ts:171 X-Cache) absent.
  - Failure: A manager hitting the cookie limit on a hand-pasted cookie, or wondering why coordinator data lags 15 s, finds nothing in FEATURES.
  - Fix: After 'the site storages a worker's upload carries.' (:3795) add: 'Since v1.393.1 (RS-480) the 8,000-character cookie limit applies only to a cookie changed in the editor, so an account whose session a fleet worker saved still saves; a refused save scrolls its error into view.' In the coordinator bullet add: 'Since v1.353.0 (RS-403) the ERP serves the console's answers from a 15-second cache (stale up to 5 min while one refresh runs; `X-Cache`/`Age` headers); any change made through the page clears it.'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-25 / P3 / P3, not verified: Root README auth/metrics/test-count facts are stale**
  - Location: `README.md:105-107, :222, :230-250, :32-35`
  - Evidence: :106 '15-minute JWT' vs apps/backend/src/auth.ts:31 TOKEN_TTL_SEC = 60*60; :222 '130+ files' vs ~260 apps/backend/tests/*.test.ts; :230-250 port 9090 is already 127.0.0.1-only (docker-compose.yml:146-150) and postgres-exporter needs profile metrics; :32-35 sidebar list (Dashboard...) vs desktopNav.ts:32-81 (Home, Analysis, ... Leads, Monitors, Accounting).
  - Failure: Readers misjudge token lifetime when debugging sessions; mis-set metrics exposure.
  - Fix: :106 'The access cookie is a 60-minute JWT. The refresh cookie (path `/api/auth`, 14 days) is a rotating family…'; :222 '250+ files'; :230-250 'Port 9090 is published on 127.0.0.1 only; scrape over localhost or an SSH tunnel. `/metrics/postgres` needs `docker compose --profile metrics up` and `POSTGRES_METRICS_PASSWORD`.'; :32-35 'see docs/FEATURES.md § The two shells' instead of the list.
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-26 / P3 / P3, not verified: Root README core env list omits FB_POOL_KEY and FLEET_WORKER_TOKEN_KEY; layout omits trackers/, deploy/, backup/**
  - Location: `README.md:182-204, :10-22`
  - Evidence: .env.example Facebook section; routes/facebookPool.ts:45,104 answer 503 without FB_POOL_KEY; index.ts:346-347 also mounts /oauth and /.well-known.
  - Failure: A self-hosted deploy following the env list gets 503 on the account pool and fleet worker routes.
  - Fix: Add both vars as 'required in production'; add trackers/reddit/, trackers/facebook/, deploy/, backup/ lines; change backend line to 'Mounted under /api/*, /oauth/*, /.well-known/*'.
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-27 / P3 / P3, not verified: Reddit README omits the v1.391.1 behaviour that an api losing the Telegram user-session hold disconnects**
  - Location: `trackers/reddit/README.md:74-79`
  - Evidence: CHANGELOG 1.391.1: 'The Reddit api disconnects its Telegram user session once another api takes the hold'; trackers/reddit/src/index.ts:139-151 holdStillOurs() disconnects on first failed renew.
  - Failure: An operator debugging two apis during a deploy expects both to stay live on the user session.
  - Fix: Insert after '…or its hold is two minutes stale.': 'An api that finds its hold taken (a renew that matches no row) disconnects at once and never uses the session again, so it is never live from two IPs.'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-28 / P3 / P3, not verified: Reddit README layout, test count and watch-loop scope are stale**
  - Location: `trackers/reddit/README.md:412-440, :205, :322`
  - Evidence: Layout omits src/seen.ts, src/userSender.ts, src/loops/reads.ts, src/loops/watch.ts, scripts/telegram-login.ts; :205 '213 tests' vs ~285; :322 loop list '(poll, evaluate, notify)' vs watch.ts:85 alerting on every registered loop. ALLOW_DESTRUCTIVE_RESET (scripts/migrate.ts:94) undocumented.
  - Failure: Minor onboarding confusion.
  - Fix: :440 '`loops/` poll, evaluate, notify, trace (workers); reactions, watch, user-notify, reads (api only); runner.ts is the shared ticker' plus the missing files; :205 drop the count; :322 '(any registered loop: poll, evaluate, notify, trace, reactions, user-notify, reads)'.
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-29 / P3 / P3, not verified: Facebook README `rsc vault set-account --account` flag is wrong (`--account-id`)**
  - Location: `trackers/facebook/README.md:859`
  - Evidence: trackers/facebook/rs_coordinator/rs_coordinator/cli.py:1106 v_set.add_argument('--account-id', required=True).
  - Failure: The documented command fails with an argparse error.
  - Fix: Replace with: `rsc vault set-account --account-id <id> --vnc-url …`
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-30 / P3 / P3, not verified: Facebook README console Watch / RS_WORKER_CONFIGS and rs-monitor scripts describe retired containers**
  - Location: `trackers/facebook/README.md:694-707, :840-857, :862-865, :885-898, :553, :641-686, :705, :1214`
  - Evidence: deploy/docker-compose.console.yml sets RS_WORKER_CONFIGS and RS_VNC_TARGETS empty; worker-status.sh:17, monitor-view.sh:18, eval-keywords.sh:23, fleet-verify.py:128 default to container rs-monitor, which no compose file defines; ERP fleet workers are rs-worker-* on fleet-agent hosts.
  - Failure: An operator tries console Watch or worker-status.sh against nonexistent containers while debugging a live worker.
  - Fix: Mark these sections 'Legacy (retired 0.14.8-0.14.14)' and add: 'Watch ERP fleet workers from the ERP Fleet page (relay `/api/fleet/vnc/:workerId/ws`); for logs use `docker logs --since` on the fleet-agent host and OpenSearch `fb-tracker-*`.'
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-31 / P3 / P3, not verified: Facebook README fleet-mode env and claim details stale (RS_FLEET_CLAIM_TICKET, home cities) and withheld-alert stopgaps undocumented**
  - Location: `trackers/facebook/README.md:397-406, :440-452`
  - Evidence: rs_worker/entry.py:4,:72 RS_FLEET_CLAIM_TICKET (0.14.5); home cities removed by RS-439 (ERP CHANGELOG 1.374.0); scripts/ai-verdict-bridge.py, fleet-alert-sender.py, fleet-log-follow.py cron stopgaps (trackers/facebook/CHANGELOG Unreleased, RS-453/455) unmentioned while :440 says fleet alerts are off.
  - Failure: An operator concludes withheld alerts never reach Telegram, or configures a worker with only the host token.
  - Fix: :397-403 'With `RS_FLEET_URL`, `RS_FLEET_HOST_ID` and either `RS_FLEET_CLAIM_TICKET` (single-use, minted by the agent before `docker run`; a 401 exits 75 before the browser) or `RS_FLEET_HOST_TOKEN` (older agents)…'; drop 'home cities' at :406; after :452 add a 'Withheld alerts (stopgap, RS-453/455)' paragraph naming the three cron scripts and where they run.
  - Regression test: none (docs); optional grep check in CI

- [ ] **C1-32 / P3 / P3, not verified: Facebook README setup/tests/release sections out of date (venv layout, suites, pyproject count) and AGENTS.md size note**
  - Location: `trackers/facebook/README.md:231-233, :1369, :1394-1413; trackers/facebook/AGENTS.md ('around 860 lines')`
  - Evidence: Real layout .venv-coordinator + .venv-aimm; release.sh:151-159 runs six suites, release.sh:175-176 bumps five pyproject files; README says three suites / both pyproject files; README is 1450 lines.
  - Failure: Contributor runs the wrong venv/suite before a release.
  - Fix: Rewrite Setup to name .venv-coordinator (rs_* packages) and .venv-aimm (rs_worker); Tests: list rs_console, rs_fleetd, rs_router and `.venv-aimm/bin/python -m pytest rs_worker/tests`, and 'release.sh runs six suites (not rs_worker or rs_router)'; :1369 'the five pyproject.toml files release.sh bumps'; AGENTS.md 'around 1450 lines'.
  - Regression test: none (docs); optional grep check in CI

- [ ] **C2-03 / P3 (raised as P2) / confirmed: backup/README.md and backup/railway.toml call the R2 backup cron `db-sync`, but `db-sync` is the prod→dev copy; the backup service is `pg-r2-backup`**
  - Location: `backup/README.md:3; backup/railway.toml:1`
  - Evidence: B1 lists the services of recycle-erp-experiment: pg-r2-backup 3224fca5 (last success 2026-10-31 03:30:51Z, tracks main) and db-sync 006cd405 (the dev-env prod→dev sync, last success 2026-10-27, B1-03). deploy/railway-sync/railway.toml:1 and docs/deployment-railway-dev-prod.md:16 also call the sync `db-sync`, and docs/deployment-railway-cloudflare-backups.md:5,53 call the backup `pg-r2-backup`. docs/agents/erp-ops.md:44 tells readers to look for 'fleet NOT restored' in 'the db-sync log', which is the sync.
  - Failure: Someone checking whether backups ran opens db-sync's logs per backup/README.md:3. Since 2026-10-27 those are failed prod→dev syncs (B1-03), so they conclude backups are failing and act on the wrong service, or treat the sync's failures as backup noise. Meanwhile the real backup service goes unwatched.
  - Fix: backup/README.md:3: "A **Railway cron service** (`pg-r2-backup` in the `recycle-erp-experiment` project, production environment; not `db-sync`, which is the prod→dev copy in `deploy/railway-sync/`)". backup/railway.toml:1: "# Railway config-as-code for the `pg-r2-backup` service (the daily Postgres -> R2".
  - Regression test: None (doc).
  - Verifier: Railway MCP, read-only, project recycle-erp-experiment. list-services shows both pg-r2-backup (3224fca5) and db-sync (006cd405). get-service-config: pg-r2-backup has rootDirectory /backup and configFile /backup/railway.toml, with R2_* and DATABASE_URL variable names. db-sync has no production config; in dev it uses rootDirectory deploy/railway-sync, cron 0 4 * * *, and PROD_DATABASE_URL/DEV_DATABASE_URL variable names. backup/README.md:3 and backup/railway.toml:1 still name the backup service `db-sync`, and no doc in the repo says `pg-r2-backup`. (The misnaming is real and checked against the live service names. It is a docs-only misdirection with no effect on whether backups run or on data, and someone looking up the service on Railway sees both names plus the root directory. That is narrow maintainability, so P3 rather than P2.)

- [ ] **C2-04 / P3 / P3, not verified: Test-database docs point at a gitignored docker-compose.override.yml on 127.0.0.1:5432; the suite reads TEST_DATABASE_URL (recycle-erp-testdb, 55432)**
  - Location: `apps/backend/AGENTS.md:192-193; docs/agents/erp-ops.md:54-56`
  - Evidence: docker-compose.override.yml is in .gitignore:55-56 and exists in no checkout (neither this worktree nor ~/Projects/recycle_servers_v2/recycle_servres_erp). apps/backend/tests/helpers/global-setup.ts:26-32 takes TEST_DATABASE_URL from the env or the repo-root .env and throws without it. The running test DB is container recycle-erp-testdb on 127.0.0.1:55432, as docs/DATABASE.md:94 and trackers/facebook/AGENTS.md:173-175 say. The doc also names `global-setup.ts` without its helpers/ directory.
  - Failure: A fresh clone follows apps/backend/AGENTS.md, has no override file, and can't make 5432 reachable (docker-compose.yml:12-13 deliberately publishes no port). Or they publish 5432 by hand while TEST_DATABASE_URL points elsewhere, and global-setup throws 'TEST_DATABASE_URL not set'.
  - Fix: apps/backend/AGENTS.md:192-193: "They need `TEST_DATABASE_URL` (repo-root `.env`), normally the `recycle-erp-testdb` container on `127.0.0.1:55432` (`docker run -d --name recycle-erp-testdb -e POSTGRES_PASSWORD=… -p 127.0.0.1:55432:5432 postgres:18`).  Production compose publishes no Postgres port." and change `global-setup.ts` to `tests/helpers/global-setup.ts` at :196 and :200. docs/agents/erp-ops.md:54-56: "…over the compose net.  Host-side tests use their own `recycle-erp-testdb` container on `127.0.0.1:55432`.  Never bind Postgres to `0.0.0.0`."
  - Regression test: None (doc).

- [ ] **C2-05 / P3 / P3, not verified: DATABASE.md misses columns from migrations 0209, 0215, 0219 and 0220, plus the fleet_slots_claim_idx unique index**
  - Location: `docs/DATABASE.md:1400 (after_sales_cases), :2272 (fleet_hosts), :2334 (fleet_proxy_checks), :2401 (fleet_slots indexes), :2549 (reddit_leads), :2584 (reddit_lead_buyers)`
  - Evidence: I built all three schemas from scratch (ERP: migrate.mjs, 218 files, head 0220; Reddit: migrate.ts, head 0008; coordinator: Database(SCHEMA + *_EXTRA_COLUMNS)) and diffed them against every #### section and column row. All 91/19/33 tables match. Every column type and NOT NULL flag matches, except these 14 columns, which have no row: after_sales_cases.currency_code char(3) NOT NULL DEFAULT 'USD' CHECK IN ('USD','CNY') (0220); fleet_hosts.agent_instance text, agent_daemon text, agent_seen_at timestamptz (0209:9-11); fleet_proxy_checks.city, region, country, org text (0215); reddit_leads.sales, buys integer NOT NULL DEFAULT 0, latest_post_title, latest_post_url text NOT NULL DEFAULT '' (0219); reddit_lead_buyers.sales, buys integer NOT NULL DEFAULT 0. Index fleet_slots_claim_idx = UNIQUE (host_id, claim_id) WHERE claim_id IS NOT NULL (0207) is not under :2401. The SQL-function table (:2690-2709) lacks fleet_archive_attempt and fleet_fence_pool_owner, which are only described in prose at :2472/:2489, and reddit_lead_events_lock (prose at :2635).
  - Failure: Someone writing a report SQL from DATABASE.md sums after_sales_cases.amount as USD, but since 0220 RMB cases exist. Or they miss the claim uniqueness the fleet's slot claim relies on and hand-insert a duplicate claim.
  - Fix: Add rows as above to each table (e.g. after :1400 table: "| `currency_code` | `char(3)` | ✓ | `'USD'` | Currency `amount` is in: USD or CNY (v1.395.0). |"; fleet_hosts: "| `agent_instance` | `text` |  |  | The agent instance that holds the host; a second instance is refused while this one keeps calling. |", "| `agent_daemon` | `text` |  |  | The Docker daemon id the instance reported. |", "| `agent_seen_at` | `timestamptz` |  |  | When that instance last called. |"). Change :2401 to "- **Indexes:** `fleet_slots_host_id_idx` (host_id), `fleet_slots_proxy_id_idx` (proxy_id), unique `fleet_slots_claim_idx` (host_id, claim_id) WHERE claim_id IS NOT NULL". Add the three functions to the :2690 table.
  - Regression test: A docs/review-2026-10-31/repro-style check, kept as a CI script: build the schema, then diff information_schema.columns against DATABASE.md's column rows (the script used here: parse '#### `t`' plus '| `col` |').

- [ ] **C2-06 / P3 / P3, not verified: DATABASE.md 'As of' line, the Overview table counts and the migration count are stale**
  - Location: `docs/DATABASE.md:11-12, :41, :43, :105-106`
  - Evidence: :11 says ERP migration 0219, Reddit 0007, Facebook tracker 0.13.18; the heads are 0220_after_sales_currency.sql, 0008_user_sender_owner.sql and VERSION 0.15.0. :41 gives the ERP 69 tables; the built schema has 90 base tables + 1 view (fleet_minutes). :43 gives the coordinator 32 tables; Database() creates 33. :105-106 says '203 numbers, 201 files'; there are 218 files over 0001-0220.
  - Failure: A reader uses the As-of line to decide which migrations still need documenting and skips 0220 and reddit 0008. The table counts make the doc look like it is missing ~22 ERP tables, so a reviewer distrusts sections that are actually current.
  - Fix: :11-12: "**As of 2026-10-31:** ERP migration `0220`, Reddit tracker migration `0008`, Facebook tracker `0.15.0`." :41 last cell: "90 + 1 view". :43 last cell: "33". :105-106: "The numbering has gaps: 220 numbers, 218 files."
  - Regression test: Same schema-diff script can assert the As-of migration equals the highest file.

- [ ] **C2-07 / P3 / P3, not verified: Small path and fact drift in the area AGENTS.md files**
  - Location: `trackers/facebook/AGENTS.md:11, :34, :59; apps/backend/AGENTS.md:59-63; AGENTS.md:50`
  - Evidence: trackers/facebook/AGENTS.md:11 says the README is 'around 860 lines'; trackers/facebook/README.md is 1450. :34 names `rs_coordinator/db.py`, but the file is trackers/facebook/rs_coordinator/rs_coordinator/db.py; docs/DATABASE.md:43 has the same short path. :59 names `rs_console/settings.py`, which is rs_console/rs_console/settings.py. apps/backend/AGENTS.md:59-63 lists the routes/orders modules, but routes/orders/aiReview.ts is not in the list. AGENTS.md:50 lists the facebook components as 'coordinator, console, poster, messenger, router', which leaves out rs_fleetd and rs_worker (both directories exist).
  - Failure: Someone opens the wrong path, or doesn't find the Review-mode AI module in routes/orders/ and adds a parallel one, contrary to the 'one module per concern' rule.
  - Fix: trackers/facebook/AGENTS.md:11 "(around 1,450 lines)"; :34 "`rs_coordinator/rs_coordinator/db.py`"; :59 "`rs_console/rs_console/settings.py`". apps/backend/AGENTS.md:62: "photos), `checks` (Review mode), `aiReview` (the PO AI review) and `spreadsheet`". AGENTS.md:50: "coordinator, console, fleet agent (rs_fleetd), worker, poster, messenger, router".
  - Regression test: None (doc).

- [ ] **C2-08 / P3 / P3, not verified: The long-form Railway runbooks erp-ops.md points to still describe the pre-release setup**
  - Location: `docs/deployment-railway-dev-prod.md:73-74, :141; docs/deployment-railway-cloudflare.md:1-6, :329; docs/agents/erp-ops.md:7-8`
  - Evidence: deployment-railway-dev-prod.md:73 says 'Prod deploys also run automatically on pushes to the `prod` branch'. That branch was retired 2026-07-20 (the same file's :3-7, erp-ops.md:89-91): the prod Worker deploys on main. :141 says the sync runs 'after the 03:00 backup', but backup/railway.toml runs it at 30 3 * * * (03:30). deployment-railway-cloudflare.md:3-6 still calls Railway an 'EXPERIMENTAL' second target that 'does not replace the production Docker Compose stack', and :329 says 'do not merge to main'. Railway recycle-erp-experiment is production (AGENTS.md:45, B1). erp-ops.md:7-8 points at both files as the long-form runbooks with no caveat.
  - Failure: An operator reads deployment-railway-cloudflare.md, takes Docker Compose for production, and treats a Railway incident as an experiment outage. Or they push to `prod` expecting a Worker deploy that never happens.
  - Fix: deployment-railway-dev-prod.md:73-74: "Prod deploys also run automatically on pushes to `main` (`.github/workflows/deploy-frontend.yml`, …)"; :141: "`0 4 * * *` (after the 03:30 backup)". deployment-railway-cloudflare.md:3-6: replace the banner with "> **Historical (2026-05).** This was the first Railway + Cloudflare setup. Railway `recycle-erp-experiment` is now production; see docs/deployment-railway-dev-prod.md and docs/agents/erp-ops.md." and drop :329.
  - Regression test: None (doc).

- [ ] **C3-01 / P3 (raised as P2) / confirmed: RS-290 and RS-291 (Facebook session bugs, RS-291 is P1) sit in backlog although both shipped in facebook-tracker 0.10.4-0.10.6**
  - Location: `docs/tickets/RS-291-a-worker-s-saved-login-survives-any-restart-until-fa.md:5; docs/tickets/RS-290-idle-session-check-reads-a-stale-page-url-and-misses.md:5; docs/tickets/INDEX.md (RS-290, RS-291 rows)`
  - Evidence: RS-290 status: backlog, pr/version empty; fixed by f705cef6 (#722), released dcf869a9 facebook-tracker v0.10.4, trackers/facebook/CHANGELOG.md:1290-1300 ('A login finished over Watch is picked up between sweeps'), and docs/debug-notes/2026-10-17-login-finished-over-watch-stays-session-expired.md:59 says 'RS-290, fixed in 0.10.4'. RS-291 status: backlog, priority P1, all 5 acceptance boxes [x]; fixed by 0eed999a (#723, v0.10.5) and 51191d67 (#725, v0.10.6), CHANGELOG 0.10.5 'A saved session survives a restart of any kind'. RS-291's own Context (line 29) already cites RS-290 as fixed in 0.10.4.
  - Failure: An agent asked to pick up open Facebook work lists backlog tickets (`scripts/ticket.sh list --status backlog`) and finds a P1 'saved login survives any restart'. RS-291's unchecked-looking live acceptance step is 'a logged-in worker restarted with docker restart ... comes back logged in' and RS-290's open box is a live login over Watch; re-verifying a shipped fix that way is exactly the worker restart / login the root AGENTS.md first rule forbids, risking a checkpointed account.
  - Fix: RS-290: line 5 `status: done`, line 10 `pr: 722`, line 11 `version: facebook-tracker 0.10.4`. RS-291: line 5 `status: done`, `pr: 723, 725`, `version: facebook-tracker 0.10.5, 0.10.6`. Then `scripts/ticket.sh index`.
  - Regression test: A ticket lint (C3-repro idea): for every ticket not done/wont-do, grep `git log origin/dev --grep=<id>` for a `Release facebook-tracker` or `v1.x` commit and fail if the ticket has none of pr/version but its id appears in a released commit.
  - Verifier: repro/C3-verify/C3-01.txt: `scripts/ticket.sh list --status backlog` lists RS-290 and RS-291 (both P1, status: backlog, empty pr:/version:, INDEX.md:197-198). Fix commits are in released tags: f705cef6 (RS-290 cookies-before-url) first in facebook-tracker/v0.10.4; 0eed999a (RS-291 fsync/stop_grace) in v0.10.5; 51191d67 (coordinator refuses empty backup) in v0.10.6; trackers/facebook/CHANGELOG.md 0.10.4-0.10.6 and README.md:1315 describe the shipped behaviour; stop_grace_period present in trackers/facebook/deploy/docker-compose.worker.yml. (Status drift is real and reproduced. Severity lowered to P3: it is ticket bookkeeping, not code/data. Part of the failure scenario is wrong: RS-291's live 'docker restart ... comes back logged in' box is already checked [x], so it invites no re-verification; only RS-290's live Watch-login box is open, which is an operator action, and the root AGENTS.md first rule already forbids an agent restarting/relogging a worker to verify. Fix: set both to done with pr (#722, #723/#725) and version (0.10.4 / 0.10.6), and decide whether RS-290's live box is waived.)

- [ ] **C3-02 / P3 / P3, not verified: Twelve more tickets still in-review/in-progress although their PR merged and their version is tagged (and on main)**
  - Location: `docs/tickets/RS-003-*.md:5, RS-004-*.md:5, RS-007-*.md:5, RS-029-*.md:5, RS-117-*.md:5 (+pr empty at :10), RS-280-*.md:5 (+pr empty), RS-293-*.md:5, RS-296-*.md:5, RS-297-*.md:5, RS-300-*.md:5, RS-312-*.md:5, RS-305-*.md:5`
  - Evidence: gh pr view: #226 MERGED 2026-08-31 (v1.109.0), #227 MERGED (v1.113.0), #231 MERGED (v1.114.2, CHANGELOG.md:11004 describes the fix), #283 MERGED (v1.130.0), #418 MERGED (RS-117, v1.183.0, CHANGELOG.md:8311), a3d183ae #708 (RS-280, v1.277.0, CHANGELOG.md:3885), #731/#732 MERGED (RS-293), #736/#737/#744 MERGED (v1.282.0/1.283.0/1.285.0, on main), #766 MERGED (v1.292.0, ancestor of origin/main). All referenced v* tags exist. RS-305's note says 'moves to done once a real reaction shows up in GET /api/prompt-stats'; CHANGELOG.md:3474 ('Since RS-305 the Reddit tracker scores...') indicates reactions are being scored.
  - Failure: INDEX.md reports 10 in-review and 5 in-progress tickets, most of them shipped weeks ago; anyone using the index or `ticket.sh list --status in-review` to find unfinished work re-opens shipped features, and the real open items (RS-394, RS-403, RS-421, RS-455, RS-468) are buried.
  - Fix: Set `status: done` on each; fill RS-117 `pr: 418`, RS-280 `pr: 708`; for RS-007/RS-117 tick the acceptance boxes the CHANGELOG entry confirms (or note 'verified by CHANGELOG [1.114.2]/[1.183.0]'). RS-293 and RS-305 keep a one-line note that their unticked item is a live check the owner owns (RS-293:60 'Live: after deploy... va-1') rather than staying in-review. Re-run `scripts/ticket.sh index`.
  - Regression test: Same lint as C3-01.

- [ ] **C3-03 / P3 / P3, not verified: RS-394 (ERP fleet, the live cutover project) is marked backlog with WS-A..D unchecked although they shipped**
  - Location: `docs/tickets/RS-394-facebook-workers-pull-cities-from-an-always-on-fleet.md:5 and :66-77`
  - Evidence: status: backlog; acceptance WS-A..WS-D '- [ ]' while docs/superpowers/plans/2026-10-24-erp-fleet/README.md:146-151 records A merged (#875,#880), B merged (#881,#885), C done (#879,#886,#887,#892), D (apps/fleet-agent exists), E/E2 done; migrations 0206-0217 fleet_* exist; docs/FEATURES.md:3472 'since v1.337.0 (RS-394)'; docs/DATABASE.md:2209 lists the fleet tables (WS acceptance line 86-87 also met). Line 66 still names `0205_fleet.sql`, which landed as 0206.
  - Failure: The ticket for the largest in-flight project reads as not started; an agent planning fleet work from the ticket rebuilds WS-A..D or assumes the coordinator still owns the fleet.
  - Fix: Line 5 `status: in-progress`; tick WS-A..WS-D and the docs item (line 86) with their PRs/versions; change line 66 `0205_fleet.sql` -> `0206_fleet.sql`; leave WS-F/WS-G open.
  - Regression test: None (docs).

- [ ] **C3-04 / P3 / P3, not verified: RS-014 (bank ignore rules) left in-progress although the same feature shipped as RS-105 (v1.177.0)**
  - Location: `docs/tickets/RS-014-a-taught-ignore-rule-hides-a-recurring-pattern-of-ba.md:5,12`
  - Evidence: RS-014 ask: 'i can ignore certain pattern of transaction in the mercury. like a ignore rule'; status in-progress, 12 unchecked, no pr/version, related: []. RS-105 'Ignore rules for bank transactions' is done, pr #403, version 1.177.0, all boxes ticked; CHANGELOG.md:8566 '**Ignore rules on the Payments page** (RS-105)'. RS-014's design doc docs/superpowers/specs/2026-09-02-bank-ignore-rules-design.md is the only spec on the topic.
  - Failure: The oldest in-progress ticket in the index is a duplicate; someone picking it up builds a second ignore-rule system next to bank_ignore rules.
  - Fix: Line 5 `status: wont-do`, related: [RS-105], and a Notes line 'Superseded by RS-105, shipped in v1.177.0.' (or `done` + `version: 1.177.0` if the owner considers RS-105 its delivery).
  - Regression test: None.

- [ ] **C3-05 / P3 / P3, not verified: Done tickets missing pr:/version: (or with a malformed frontmatter line)**
  - Location: `docs/tickets/RS-321-table-action-column-stays-visible-while-the-other-co.md:10; RS-294-*.md:10; RS-429-*.md:10; RS-456-*.md:10; RS-404-*.md:11; RS-258-*.md:11`
  - Evidence: RS-321 line 10 is `pr: "#785"version: 1.294.1` (newline lost), so field() reads no version and INDEX shows '—' though d2d6a86b is v1.294.1. RS-294 pr empty (merged as #768, 1b25ac72). RS-429 pr empty (93f112f3 = #958, v1.370.3). RS-456 pr empty (9372b7af = #996, v1.380.1). RS-404 version empty (#913 is a docs-only prompt candidate). RS-258 version 'n/a — trackers/facebook [Unreleased]' but its fix (7ac27331, #661) is in facebook-tracker/v0.6.0 and trackers/facebook/CHANGELOG.md:1690 under [0.6.0].
  - Failure: The pr:/version: fields are the join from ticket to CHANGELOG (AGENTS.md 'Tickets' step 4); lookups by version or PR miss these six, and RS-258 claims its fix never shipped.
  - Fix: RS-321: split line 10 into `pr: "#785"` and `version: 1.294.1`. RS-294: `pr: 768`. RS-429: `pr: 958`. RS-456: `pr: 996`. RS-404: `version: n/a — reddit prompt candidate, docs only, no release`. RS-258: `version: facebook-tracker 0.6.0`. Re-run index.
  - Regression test: scripts/ticket.sh index could warn when a done ticket has an empty pr or version, like its duplicate-id warning.

- [ ] **C3-06 / P3 / P3, not verified: INDEX.md is stale for RS-483: Shipped shows '—' though the ticket says 1.395.0**
  - Location: `docs/tickets/INDEX.md:8`
  - Evidence: INDEX.md:8 `| ... After-sales case amount can be in RMB | — |`; docs/tickets/RS-483-after-sales-case-amount-can-be-in-rmb.md:11 `version: 1.395.0`. Regenerating with the reindex logic changes only this row. The close commit 62f53dec filled version: without re-running `scripts/ticket.sh index`.
  - Failure: The newest release's ticket reads unshipped in the index anyone reads first.
  - Fix: INDEX.md:8 replace `| — |` with `| 1.395.0 |` (i.e. run `scripts/ticket.sh index`).
  - Regression test: None; ticket-workflow skill's close step could run index after filling version.

- [ ] **C3-07 / P3 / P3, not verified: CHANGELOG.md has an empty stray `## [Unreleased]` heading in the middle of the file**
  - Location: `CHANGELOG.md:1589`
  - Evidence: The only `## [Unreleased]` heading sits between [1.344.0] (line 1569) and [1.343.0] (line 1591), with no body. scripts/changelog.sh:152-189 treats an Unreleased section specially and :264 tells authors to write 'under ## [Unreleased]'.
  - Failure: An author following changelog.sh's hint adds notes under the heading they find, 1,500 lines down among 2026-10-24 releases, and the notes never appear at the top; backfill may also fold it oddly.
  - Fix: Delete CHANGELOG.md:1589 and its following blank line.
  - Regression test: None.

- [ ] **C3-08 / P3 / P3, not verified: CHANGELOG.md [1.333.2] sits below [1.333.1], breaking newest-first order**
  - Location: `CHANGELOG.md:1914-1950`
  - Evidence: Order is [1.333.1] (1914), [1.333.2] (1938), [1.333.0] (1950); the file header says 'newest first'. v1.333.2 is the prod hotfix tagged 2026-10-24 23:55 -0400.
  - Failure: Readers scanning top-down meet the hotfix after the release it fixed; scripts comparing adjacent headers see an inversion.
  - Fix: Move the [1.333.2] block (lines 1938-1949) above `## [1.333.1] - 2026-10-24` at line 1914.
  - Regression test: None.

- [ ] **C3-09 / P3 / P3, not verified: facebook-tracker tag v0.13.3 has no CHANGELOG section (renamed to 0.13.4)**
  - Location: `trackers/facebook/CHANGELOG.md:911-922; tag facebook-tracker/v0.13.3 (ba8bfd3a)`
  - Evidence: At the v0.13.3 tag CHANGELOG had `## [0.13.3] - 2026-10-19` (pre-screen default model, RS-317). Five minutes later 53be6069 'Release facebook-tracker v0.13.4' renamed that section to [0.13.4] and corrected RS-317->RS-319, so the current file has [0.13.4] then [0.13.2]. Every other facebook-tracker/v* tag has a section; 0.1.0 and 0.4.0 have sections but no tags (pre-import history, see AGENTS.md 'Imported hashes').
  - Failure: Someone checking what the fleet ran on 0.13.3 (e.g. from `docker inspect` labels or the login ledger) finds no entry and may assume the tag is bogus.
  - Fix: Insert before line 922: `## [0.13.3] - 2026-10-19\n\nSame tree as 0.13.4; re-cut because this section cited the wrong ticket (RS-317 for RS-319).`
  - Regression test: None.

- [ ] **C3-10 / P3 / P3, not verified: Two debug notes still say the transfer-orders test flake is unfixed; the fixture was fixed in v1.191.0**
  - Location: `docs/debug-notes/2026-07-29-transfer-order-reopen-test-flake.md:4; docs/debug-notes/2026-08-03-transfer-orders-draft-so-test-flake.md:3`
  - Evidence: Notes say 'Status: diagnosed, not fixed' / 'pre-existing, unfixed' and tell readers to run the file 4-6 times. apps/backend/tests/transfer-orders.test.ts:27-34 now filters `!committed.has(i.id)` via committedLineIds() (added b43b89c2, v1.191.0, RS-130), and inventory.ts:266 has the `l.id` tiebreaker (ec0eb4c9, v1.258.5). The two notes also duplicate each other.
  - Failure: A developer who sees a real transfer-orders failure dismisses it as 'the known flake' per these notes and ships a regression.
  - Fix: Replace 2026-07-29 line 4 with `**Status:** fixed in v1.191.0 (RS-130): transferOne() skips lines a committed sell order holds.` and 2026-08-03 line 3 with `**Status:** fixed in v1.191.0 (RS-130); the inventory list gained the l.id tiebreaker in v1.258.5. A failure here is now real.`
  - Regression test: None.

- [ ] **C3-11 / P3 / P3, not verified: Debug note says the new-worker logged-out search is fixed, then says the monitor 'still has the gap'**
  - Location: `docs/debug-notes/2026-10-17-new-worker-without-session-file-searches-logged-out.md:50-52`
  - Evidence: Line 3: 'Fixed in facebook-tracker 0.10.1 (RS-286): a missing file now has a fingerprint of its own'; lines 50-52: 'The monitor itself still has the gap. The real fix ... is a vendored-monitor change'. RS-286 is done at facebook-tracker 0.10.1.
  - Failure: A reader stops at the end and seeds empty fb_state.json files by hand on new workers (a write into configs/sessions/, which the ground rules treat as login-sensitive).
  - Fix: Replace lines 50-52 with: `0.10.1 (RS-286) made that vendored-monitor change: a missing file parks the worker, so the empty-file step is history.`
  - Regression test: None.

- [ ] **C3-12 / P3 / P3, not verified: erp-fleet plan README carries two contradictory WS-F status rows and a status section frozen at 2026-10-27**
  - Location: `docs/superpowers/plans/2026-10-24-erp-fleet/README.md:41, :103-153`
  - Evidence: Row at :41 says the MVP run, coordinator wiring and dev pilot are done; the Status table row F at :152 still says 'registry moved to OCIR ... token blocked on the owner ... Owner steps: free an auth token'. :153 'G not started'. Last edit f2015d6b 2026-10-27; since then RS-454/456/461/463/469/472 (v1.380-1.389) run the fleet on worker-60-14 and homelab hosts (RS-468 notes: 15 accounts leased in prod).
  - Failure: An agent following the plan's README 'update the status table' rule (line 91) reads F as blocked on an OCIR token and re-does host prep, or treats the fleet as dev-only.
  - Fix: Replace README.md:152 with `| F | MVP, coordinator wiring, dev pilot and legacy migration done (RS-419..RS-426, #940-#951); fleet live on worker-60-14 and homelab | #876, #883, #891, #902, #903, #940-#951 | see rows above and WS-H |` and add a dated line under '## Status' pointing to RS-454+ for post-cutover work.
  - Regression test: None.

- [ ] **C3-13 / P3 / P3, not verified: docs/superpowers/plans/finished/ convention abandoned: ~33 shipped or dropped plans from May-July stay at top level with no status**
  - Location: `docs/superpowers/plans/ (top level, 2026-05-11 .. 2026-07-05); AGENTS.md:223`
  - Evidence: finished/ holds 5 plans moved in May (eefd5691); nothing since. Top-level plans with every box unticked include shipped work (2026-05-16-transfer-orders.md: transfer orders exist, 1de98259; 2026-05-22-sell-order-archive.md; 2026-06-08-sell-order-packing-list.md: RS-029 v1.130.0; 2026-05-17-per-order-commission-rate.md) beside likely-dropped ones (2026-05-21-system-metrics-sidecar.md: no sidecar in compose/deploy). Only 2026-05-16-orphan-label-scan-sweep.md has a status line ('DEFERRED'). AGENTS.md:223 calls the folder 'in-flight and finished'.
  - Failure: A reader cannot tell in-flight from finished plans; an agent executing 'the plan' for a feature re-runs tasks for something already shipped (unticked boxes read as to-do).
  - Fix: Either move shipped plans into finished/ and add `> **Status:** abandoned (<date>)` to dropped ones, or drop the finished/ folder and require a first-line status in each plan; update AGENTS.md:223 to name the convention.
  - Regression test: None.

- [ ] **C3-14 / P3 / P3, not verified: AGENTS.md says each tracker keeps its debug notes under its own docs/, but Facebook's live in the root docs/debug-notes**
  - Location: `AGENTS.md:227-228`
  - Evidence: trackers/facebook/docs/ holds only architecture.drawio; the Facebook notes (2026-10-17-2zie-2fa-is-plain-totp.md, -login-finished-over-watch..., 2026-10-18-va-1-locked..., 2026-10-20-facebook-duplicate-alerts..., 2026-10-20-forty-workers...) are in docs/debug-notes/, and trackers/facebook/README.md:206 links there.
  - Failure: An agent debugging a worker looks in trackers/facebook/docs per AGENTS.md, finds nothing, and misses the va-1 lock note that says to count logins before a Re-login.
  - Fix: AGENTS.md:227-228: `... their debug notes under trackers/reddit/docs/debug-notes/ and, for Facebook, docs/debug-notes/ (files named for the fleet).`
  - Regression test: None.

## Limits

- **C1**: Docs lane; no live resources touched, nothing run beyond grep/read. FEATURES.md (4326 lines) was verified section by section by sampling ~260 concrete claims (routes, role gates, limits, labels, env vars, migrations) across all sections; confirmed claims are not listed individually. CHANGELOG-vs-FEATURES was checked by script for every section >=1.300.0 with Added/Changed: FEATURES cites every release from 1.384 to 1.395.0 (newest cited = 1.395.0), so there is no release newer than FEATURES' newest citation; the only gaps are listed in C1-24. READMEs were checked against code and recent tracker changelogs. Not checked: CHANGELOG sections older than 1.300.0, FEATURES prose-only claims without a code anchor, behaviour at runtime (no servers started). Prior review docs/review-2026-10-13 has no IDs in this lane, so carryover is empty. Ticket/CHANGELOG ordering issues belong to lane C3.
- **C2**: Method: a script pulled every backticked or linked path from the target docs and resolved it against the repo; I checked the unresolved ones by hand (most were shorthand relative to a package dir, all fine apart from C2-04 and C2-07). I grepped the source for every symbol, env var and file named in apps/backend/AGENTS.md and apps/frontend/AGENTS.md; all exist. trackers/reddit/AGENTS.md checks out completely: allowlist = tracker.ts, tests, debug notes, port 5433, container name, allowBuilds, RESPONSE_SCHEMA_ID. session-isolation.md matches new-session.sh (flags, LOCAL_FILES, 8h TTL, .locks/.select). erp-ops.md: all files, the CMD exec, csp-rev, TOPICS thread ids, the ERROR_LOG_DIR mount and prevent_destroy match. DATABASE.md: I built the schemas in a disposable postgres:18 (review1031-C2 on 55622, removed afterwards) through each project's own runner. The coordinator schema came from a scratch SQLite Database() instance, since no venv with psycopg exists; pg.py renders the same SCHEMA, so the Postgres DDL was not checked separately. No live resources were touched in this lane; Railway service names and the legacy-roster retirement come from B1/B3 evidence. Not covered: trackers/facebook/deploy/README.md and trackers/reddit/infra/README.md (the tracker lanes' runbooks), and DATABASE.md prose meanings beyond the spot checks. Already raised elsewhere, so not repeated: COORDINATOR_ACCESS_* optional (B1), fbc-api Access bypass (B2), Facebook debug-note location at AGENTS.md:227 (C3).
- **C3**: No C3.files.txt existed; scope taken from the task brief. Prior review docs/review-2026-10-13 has no IDs in this lane (tickets/changelog/plans/debug notes), so carryover is empty. Checked: INDEX vs every ticket via the reindex logic (only RS-483 differs; no duplicate ids, no id/filename mismatches); every done ticket's version strings resolve to existing v*/facebook-tracker/v* tags; ERP CHANGELOG sections vs v* tags are 1:1 (670/670) plus the stray Unreleased; header dates vs tag dates differ >1 day only for 4 tags backfilled on 2026-08-31 (expected). facebook-tracker [Unreleased] content (RS-453/455/467/474 scripts) is genuinely after v0.15.0. Not done: full read of all 57 debug-note bodies (status lines grep'd, ~12 read in full); plan-by-plan shipped/abandoned verification for every May-July plan (sampled 5). RS-455 (backlog) and RS-468 (backlog) are genuinely open. No live resources touched.
