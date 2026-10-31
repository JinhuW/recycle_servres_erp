# Shared package and contracts — review 2026-10-31

Lanes: A8 (Shared and contracts). 5 findings: 0 P1 / 0 P2 / 5 P3. Severity shown is after verification; P3s were not verified.

## P3

- [ ] **A8-02 / P3 / P3, not verified: Coordinator proxy keeps two allowlisted routes no UI calls, one of them a credential write**
  - Location: `apps/backend/src/routes/coordinator.ts:227-231 (GET /stats/reviews), :266-292 (PUT /accounts/:id)`
  - Evidence: No file in apps/frontend/src calls /api/coordinator/stats/reviews or /api/coordinator/accounts/ (grep). Only coordinator-cache.test.ts and coordinator-routes.test.ts reach them. The pool's Assign writes accounts through callFacade in facebookPool.ts instead. The header comment says the allowlist exists so the UI reaches only what it needs.
  - Failure: PUT /api/coordinator/accounts/:id stays a manager-reachable path that can overwrite any vault account's password, TOTP and email secrets with no UI, no pool-ledger event and no account_no audit row. Pool Assign writes the same data with an audit row. A stolen manager session, or a script, uses the unaudited door.
  - Fix: Drop both routes and their tests, or wire them to a page. If the credential form is planned, record it in a ticket.
  - Regression test: The coordinator-routes allowlist test asserts 404 for PUT /api/coordinator/accounts/x and GET /api/coordinator/stats/reviews.

- [ ] **A8-03 / P3 / P3, not verified: Reddit proxy forwards rule create/edit/delete that no UI calls**
  - Location: `apps/backend/src/routes/tracker.ts:89-93; apps/frontend/src/lib/tracker.ts:323-324`
  - Evidence: trackerApi exposes only listRules. DesktopTracker.tsx calls listRules at :100 and :181 and nothing else. POST /rules, PATCH /rules/:id and DELETE /rules/:id are still proxied. Every allowlist entry exists on the tracker (api.ts:250-289), so none is a dead 404. These three are unused write surface.
  - Failure: A manager session (or anything holding one) can add or enable rules that are appended to the live eval prompt (prompts.ts liveConfig) with no UI showing it. That silently changes the live prompt version and splits its scores, which the tracker's AGENTS.md says must go through a candidate trial.
  - Fix: Remove the three write routes from tracker.ts (and the root/trackers/reddit AGENTS.md lists), or add the rule editor they were meant for.
  - Regression test: tracker-routes.test.ts 'rejects paths outside the allowlist' asserts POST /api/tracker/rules is 404.

- [ ] **A8-04 / P3 / P3, not verified: Shared HeartbeatAnswer type omits the 'resume' directive and resume_id the backend sends**
  - Location: `packages/shared/src/fleet.ts:665-673; apps/backend/src/fleet/claim.ts:544-548`
  - Evidence: fleet.ts declares directives: Array<'relogin'> and only relogin_id. claim.ts answers directives [...'relogin', ...'resume'] and resume_id. fleet.ts itself defines FLEET_RESUME_SINCE for 'the first worker build that takes the resume directive'. No TS code imports HeartbeatAnswer, so the compiler never catches the drift.
  - Failure: Someone writing a TS consumer of the heartbeat (a test fake, the host agent port, an ERP-side simulator) types it from the shared file and narrows on 'relogin'. A Mark healthy then reaches a parked worker as an unknown directive and is ignored, and the worker stays parked.
  - Fix: directives: Array<'relogin' | 'resume'>; add resume_id?: string; annotate claim.ts's answer as HeartbeatAnswer so tsc enforces it.
  - Regression test: Type the heartbeat route's c.json payload with `satisfies HeartbeatAnswer`; typecheck fails on drift.

- [ ] **A8-05 / P3 / P3, not verified: ERP worker-id regex refuses '.' that the console and the VNC route accept**
  - Location: `apps/backend/src/routes/coordinator.ts:342 (WORKER_ID) vs :474 (VNC_WORKER_ID); trackers/facebook/rs_console/rs_console/app.py:267 (_WORKER_ID)`
  - Evidence: coordinator.ts WORKER_ID is ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$, but VNC_WORKER_ID in the same file and the console's _WORKER_ID both allow '.'. WORKER_ID gates /workers/:id/logins, /cities, /queue and /city-log. Today's fleet.toml ids (ne-1, se-1, mw-1, sc-1, denver-1, wc-1) have no dot, so nothing breaks yet.
  - Failure: A worker named with a dot (e.g. after an IP-like or versioned id such as 'w-10.60.14') appears on the Fleet page and can be watched over VNC. But its History, Edit cities, queue toggle and city log all answer 400 'Not a valid worker id' from the ERP, though the console would accept them.
  - Fix: Use one exported worker-id regex (the console's) for every coordinator.ts route, ideally from packages/shared.
  - Regression test: coordinator-routes test: GET /api/coordinator/workers/a.b/logins is forwarded, not 400.

- [ ] **A8-06 / P3 / P3, not verified: Proxy round's 30 s console timeout is shorter than the console's worst case when many proxies are down**
  - Location: `apps/backend/src/fleet/proxyHealth.ts:32,66-70; trackers/facebook/rs_console/rs_console/proxy_exit.py:23,97,131-143`
  - Evidence: The console probes unique proxies 8 at a time (CHECK_CONCURRENCY) with an 8 s lookup timeout, after composing /v1/fleet. The ERP aborts at CONSOLE_TIMEOUT_MS = 30 s and then records coordinator = 'unreachable' with no rows.
  - Failure: With 25 or more distinct proxy ports dead or timing out, the console needs at least 4 waves × 8 s = 32 s, so the ERP aborts. The Proxies tab then shows 'console unreachable' and drops every coordinator row, at exactly the moment the operator needs to see which proxies are down.
  - Fix: Make the ERP timeout exceed ceil(ports/8)*8 s plus the fleet composition (e.g. 60 s, within Cloudflare's 100 s), or have the console cap its total probe time and return partial rows marked timed out.
  - Regression test: fleet-proxy-health.test.ts: a fake console that answers after 31 s still yields coordinator 'ok' rows.

## Reported here, tracked elsewhere

- A8-01: [cross-lane] ERP depends on five rs_console routes that neither contract doc lists (facebookPool.ts calls the console directly) → tracked as **C2-02**

## Limits

- **A8**: Contract tests: I ran tracker-routes, coordinator-routes, fleet-proxy-health and wechat-market, plus vnc-bridge, coordinator-cache and facebook-pool, against my own PG18 (review1031-A8, :55608) after baseline DONE. Result: 7 files, 136/136 passed in 26 s. The full baseline run (backend-test rc=1, 1218 s) marks wechat-market, vnc-bridge and fleet-proxy-health failed, but those are 'Hook timed out in 30000ms' under suite load (23 timeouts in the log), not contract failures; they pass in isolation. Allowlist check: every ERP route in tracker.ts maps to an existing route in trackers/reddit/src/api.ts, and every coordinator.ts, vncBridge (ticket and ws) and proxyHealth path maps to an existing rs_console route, so there are no missing or 404 entries. Unused entries: A8-02 and A8-03. Console routes the ERP deliberately does not forward: /v1/queue/shadow and the dashboard. /session and /restore-session are reached only through facebookPool.ts (A8-01). Payload shapes: the Reddit types (matches, stats, workers, subreddits snake_case, prompt-stats, analytics, seen, prompt-candidate, promote, llm_model) match the tracker field for field. proxyHealth reads exactly the keys proxy_exit.py emits (ok, latency_ms, ip, city, region, country, org, error, url, workers). The memtrade ErpDay/ErpPoint/ErpLine/PriceStats types match WechatDayPush/WechatPoint/WechatLine/WechatPrice, buckets included. memtrade's normalize() nulls empty strings and rounds qty, which matches the ERP's strict str/count validators. Its stored-count check matches the ERP's cumulative stored_points, and the (report_date, post_key, item_index) PK is the same on both sides. Shared enum vs SQL CHECK parity verified: CLOSE_REASON_IDS (0057), CARRIERS (0094), PACKAGE_SOURCES (0106), AFTER_SALES statuses and resolutions (0175). Limits: ramPartDecode.ts and ramSheetSegment.ts were read for structure and hot paths, not every decoder table. Not checked: deployed prod/console versions, whether memtrade on the office Mac runs the erp.ts I read (its git repo has no commits), the memtrade test suite, the rs_console suite. Contract tests are ERP-side with mocked upstreams, so no automated test pins the tracker's or console's real response shapes to the ERP types; that drift is caught only by hand reviews like this one.
