# WS-B — Ops alerting: fix plan

Planned 2026-10-31 against `origin/dev` f0c1d856. Planning only: nothing below
has been run against a live resource.

## 1. Goal and scope

Every scheduled job the business relies on should either run or tell someone
it didn't. Today the prod uptime probe has been dead since 2026-10-28 21:11Z
(P1), the prod→dev sync has rolled back every night since 2026-10-28, and
none of it alerted. Two cron failures (`check.sh` exit 1, and db-sync's
SUCCESS-status failed runs) reach no one. The fix has three parts. First, the
owner restores the probe today. Second, the code gets a **dead-man's switch
that lives outside Railway**: the Cloudflare relay alerts when a heartbeat
stops arriving. Third, the job-specific bugs get fixed: the 429 misread and the
scrub's NOT NULL column. The homelab Prometheus gaps and the stale Mac and
cloud routines are closed alongside.

Findings covered (15): **A11-01** (dupe B1-01), **A5-01** (dupes B1-03,
A11-04), **B1-04**, **B4-04**, B1-07, B1-08, B1-09, B1-10, B1-11, B4-03,
B4-06, B4-08, B4-09, B4-10, B5-03.

Verified on f0c1d856 while planning:

- `deploy/railway-uptime/check.sh:30-43` still treats any non-200, including
  429, as DOWN. It exits 1 on every failure, including when the alert was
  delivered.
- `deploy/railway-sync/scrub.sql:34-47` still runs
  `UPDATE … SET <col> = NULL` on every `*_enc` column.
  `migrations/0213_fleet_proxies.sql:14` declares `url_enc TEXT NOT NULL`.
  Only `fleet_slots.proxy_id` (0213) and `fleet_proxy_checks.proxy_id` (0215)
  reference `fleet_proxies`, and both are `ON DELETE SET NULL`.
- `apps/backend/Dockerfile:68` runs `init-admin.mjs` on **every boot**. That
  matters for B1-11 (see T7).
- `claim.ts:692-740` holds next-task for up to `poll_hold_seconds`.
  `server.ts:61-72` cuts connections at `graceMs` 20 s. No hold is woken on
  SIGTERM.
- The relay (`deploy/railway-alerts/worker.js`) has no `scheduled` handler and
  no storage, so it cannot notice silence today. Its tests live in
  `apps/frontend/tests/railway-alerts-relay.test.ts`.

## 2. Tickets

Seven tickets: T1 is P1, T2 and T4 are P2, and the rest are P3.

### T1 — Uptime probe: restore it, stop the 429 false alarm, add a dead-man's switch (P1)

| | |
| --- | --- |
| Closes | A11-01 (dupe B1-01), B1-04, B1-08 |
| Versions under | ERP root `package.json`, **minor** (`deploy/` is on the version-check path list) + CHANGELOG + FEATURES (ops alerts) |
| Worker restart / FB login | None. Railway cron service + Cloudflare Worker only |
| Effort | **M** (code); owner gates G1-0 to G1-4 ≈ 1 h of the owner's time |

**Change**

1. `deploy/railway-uptime/check.sh`
   - Classify each attempt's result. `200` means ok. `429` means *throttled*.
     `000`, `5xx` and every other code mean *down*, so a 403 from a broken
     Access app still pages. On a 429, the next attempt waits for
     `Retry-After`, capped at 60 s. Otherwise it waits `${UPTIME_RETRY_SLEEP:-20}`
     seconds; the env var is only there so the test runs fast.
   - If all three attempts are throttled, log
     `[uptime] throttled: … 429 x3 (origin -> $origin_status)` and send **no
     DOWN alert**. If the origin is also not 200, it is still DOWN with
     layer=Railway. A throttled run sends no heartbeat, so throttling that lasts
     past 15 min surfaces through the dead-man's switch as "probe blind" rather
     than as a false "redeploy the Worker".
   - On ok, `POST $ALERT_BASE/heartbeat` `{"name":"erp_uptime"}` with the
     `ALERT_TOKEN` bearer. Derive `ALERT_BASE` from `ALERT_URL` by stripping
     `/alert`, so no new variable is needed. A failed heartbeat post is logged
     and ignored, because the dead-man's switch catches it.
   - Retry the alert POST once after 15 s on failure, so a single 429 on the
     relay doesn't swallow it.
   - Exit codes: exit 0 when the run's outcome was reported (an ok heartbeat, a
     throttled run, or a delivered alert). Exit 1 only when DOWN could not be
     delivered, or when `ALERT_URL` is unset (keeps today's
     "FAILED status is the signal" fallback). The last run before the outage
     exited 1 and left the deployment CRASHED. Exit 1 must stop being the
     normal alert path.
   - Send `User-Agent: recycle-erp-uptime/1` on every request, so Cloudflare
     Security Events can be filtered to the probe.
2. `deploy/railway-alerts/worker.js` + `wrangler.toml`: the dead-man's switch.
   - New route `POST /heartbeat` `{name}` with the `ALERT_TOKEN` bearer, added
     to `ROUTES`. Only names that appear in `WATCHES` are accepted (400
     otherwise). It writes `hb:<name>` = now to the KV binding `HEARTBEATS`.
     If `alerted:<name>` is set, it sends a `resolved` message to the watch's
     topic and deletes the flag.
   - A new `scheduled(event, env)` export, cron `*/5 * * * *` under
     `[triggers]`. For each entry in the `WATCHES` var
     (`{ erp_uptime: { max_age_s: 900, topic: "erp_uptime", title: "Uptime probe silent" }, erp_dbsync: { max_age_s: 93600, topic: "erp_dbsync", title: "Dev db-sync silent" } }`):
     if `hb:<name>` is older than `max_age_s` and `alerted:<name>` is unset,
     send `firing` ("no heartbeat since <ts>; Railway cron may be stopped or
     throttled") and set the flag.
   - A missing `hb:<name>` is treated as last seen at `armed:<name>`, which is
     written on the first scheduled tick. A fresh deploy therefore alerts after
     `max_age_s` if the sender never shows up, instead of staying silent
     forever.
   - Keep the logic in pure helpers (`staleWatches(now, entries, watches)`) so
     it can be unit-tested without KV.
   - The `erp_dbsync` watch is the heartbeat T2's `sync.sh` sends on success.
     It is listed here so the relay deploys once.
3. `docs/agents/erp-ops.md` → *Ops alerts*: add the `/heartbeat` route, the
   dead-man watch table, the KV namespace, and "uptime-monitor tracks `main`".
   Add a new *Scheduled jobs* table (the T6 content goes here too).

**Tests**

- `apps/frontend/tests/railway-alerts-relay.test.ts`, extended:
  - `/heartbeat`: 401 without a bearer, 400 for an unknown name, KV written
    with a fake `HEARTBEATS` Map wrapper, and `resolved` sent once after an
    alert.
  - `scheduled`: a stale heartbeat fires once and not twice; a fresh one stays
    silent; a missing heartbeat fires only after `armed + max_age_s`.
- `apps/frontend/tests/uptime-check.test.ts` (new) spawns
  `sh deploy/railway-uptime/check.sh` with `PATH` led by a temp dir holding a
  fake `curl`. The fake reads scripted status codes from a file and records
  the URLs it was called with. Set `UPTIME_RETRY_SLEEP=0`. Cases, ported from
  the A11-01 and B1-04 regression notes:
  - `429 ×3` with origin 200: no `/alert` call, exit 0, log says throttled.
  - `523 ×3` with origin 200: an `/alert` with the edge layer, exit 0.
  - `503 ×3` with origin 503: an `/alert` with the Railway layer.
  - `200`: a `/heartbeat` call, exit 0.
  - DOWN where the alert fails twice: exit 1.
  - `ALERT_URL` unset with DOWN: exit 1.

  The `repro/A11-verify` and `B1-verify` folders hold only Railway read
  scripts and no check.sh harness, so this test is new.

**Owner gates**

- **G1-0 (today, before any code):** Bring the probe back. In Railway,
  `recycle-erp-experiment/production/uptime-monitor`, create a **fresh deploy
  of the latest commit**. Do not redeploy the `c881951f` snapshot: 22 of those
  have failed with "failed to fetch snapshot".
  - Also set **Cron Schedule `*/5 * * * *`** and **Restart policy NEVER** in
    the service settings, so the schedule no longer depends on `railway.toml`
    being picked up.
  - Then confirm an `[uptime] ok` log line within 10 min.
  - Yes/no: may an agent do this through the Railway MCP (`create-deployment`
    plus `update-service`)?
- **G1-1:** Find what re-triggers a redeploy of uptime-monitor every ~4h10m.
  The audit log shows `Deployment.redeployed` under the owner's identity, and
  nothing local mentions it. Is it the owner's dashboard, a stale browser tab,
  or a Railway retry? Stop it.
- **G1-2:** In the Cloudflare dashboard → Security → Events, filter to
  2026-10-28 21:11Z and the Railway egress IP `152.55.181.187`. Identify the
  rule that answered 429 for `inventory.recycleservers.com/api/health` and for
  `railway-alerts.*.workers.dev/alert`. Then: yes/no to adding a WAF **skip
  rule for rate limiting and bot rules on `GET /api/health`** on the inventory
  zone. `/api/health` is cheap and unauthenticated, so skipping costs nothing.
  - If the relay's 429 came from a workers.dev-level limit the owner cannot
    tune, yes/no to giving the relay a custom route on a zone the owner
    controls (e.g. `alerts.recycleservers.com`). The rule also belongs in
    `infra/terraform`; hand that to **WS-C** (edge).
- **G1-3:** Run `npx wrangler kv namespace create HEARTBEATS` (the id is not a
  secret and goes into `wrangler.toml`). After merge to `dev`, deploy the relay
  with `npx wrangler@4.146.0 deploy` from `deploy/railway-alerts`.
- **G1-4 (B1-08):** Yes/no: switch the production uptime-monitor's source
  branch from `dev` to `main`. Recommended yes. It is the one prod ops service
  that skips the release gate. **WS-D** A11-10 names the same setting; WS-B
  owns the switch, and WS-D keeps the backup-doc and rclone parts.

**Rollout and verification**

1. Do G1-0 now.
2. Merge T1 to `dev` and deploy the relay (G1-3). Send one
   `POST /heartbeat {"name":"erp_uptime"}` by hand with the token from the
   owner's shell, or wait for the next probe. Check `wrangler tail` shows the
   KV write.
3. Release to `main`. The uptime-monitor redeploys from `main` (G1-4).
4. Verify (read-only):
   - Railway logs show `[uptime] ok` every 5 min.
   - KV `hb:erp_uptime` advances.
   - Optional drill: pause the cron for 20 min in the dashboard, see "Uptime
     probe silent" in ERP · Uptime, then see `resolved`.
5. Rollback: `git revert` and redeploy the relay. The old `check.sh` keeps
   working, because the heartbeat post is fire-and-forget.

### T2 — db-sync: scrub NOT NULL sealed columns by deleting the row; alert on a failed run (P2)

| | |
| --- | --- |
| Closes | A5-01 (dupes B1-03, A11-04) |
| Versions under | ERP root, **patch** + CHANGELOG |
| Worker restart / FB login | None. Dev's own fleet is untouched: keep-fleet/restore-fleet still set it aside |
| Effort | **S** |

**Change**

1. `deploy/railway-sync/scrub.sql`, the `DO` block at lines 34-47:
   - Select `a.attnotnull` along with the table and column.
   - When the column is NOT NULL, run
     `EXECUTE format('DELETE FROM public.%I WHERE %I IS NOT NULL', tbl, col)`.
     Otherwise keep the `UPDATE … SET NULL`.
   - Add a "why" comment: a sealed value that cannot be NULL makes the row
     useless on dev. Deleting it relies on the FKs onto the table being
     `SET NULL`, the same way the file relies on no-CASCADE for TRUNCATE. A
     RESTRICT FK makes the DELETE fail, and CI catches that (test below).
   - Effect today: prod's 20 `fleet_proxies` rows are dropped from dev's copy.
     Slots' `proxy_id` becomes NULL; their `proxy_url` was already nulled
     below. With `SYNC_KEEP_FLEET=1`, dev's own proxies come back through
     `restore-fleet.sql`, because `fleet_proxies` matches `fleet\_%` in
     keep-fleet.
   - This is preferred over an `''` sentinel because `fleet/proxyHealth.ts:50-53`
     unseals every row, so a sentinel would throw on dev's proxy round.
2. `deploy/railway-sync/sync.sh`: make a failure loud.
   - Send psql's stderr to `$errlog` (mktemp, removed in the trap).
   - Add an EXIT trap: on rc ≠ 0 with `ALERT_URL` set, `POST` to the relay
     `/alert`
     `{topic:"erp_dbsync", status:"firing", title:"dev db-sync failed", lines:[<first ^ERROR: line, ≤300 chars>]}`.
   - **Send only the `ERROR:` line, never `DETAIL:`.** Postgres's
     `Failing row contains (…)` would put prod row data into Telegram.
   - On the `[sync] done` paths, `POST /heartbeat {"name":"erp_dbsync"}`. That
     route exists once T1's relay is deployed; until then the post 404s and is
     ignored.
3. `deploy/railway-alerts/wrangler.toml` `TOPICS`: add `erp_dbsync = <id>`
   after G2-1. Until then the alert goes to General, which the relay already
   does for unmapped topics.
4. `docs/FEATURES.md` (the prod→dev sync section near line 3443): note that
   prod's fleet proxies are not copied. `docs/agents/erp-ops.md`: list db-sync
   as an `ALERT_TOKEN` holder. The holder list grows from 3 to 4, which affects
   rotation.

**Tests**

- `apps/backend/tests/sync-scrub.test.ts`, port of
  `docs/review-2026-10-31/repro/A5/sync-scrub-fleet-proxies.test.ts` with the
  assertion inverted. Insert a `fleet_proxies` row and a `fleet_slots` row
  pointing at it, run scrub with an empty `search_path`, and assert:
  - it commits;
  - `fleet_proxies` is empty;
  - the slot survives with `proxy_id` NULL.
- Same file, a generic guard: a `scrub_probe_nn (id INT PRIMARY KEY, secret_enc TEXT NOT NULL)`
  probe table, whose row is gone after scrub.
- Same file, a schema-derived invariant: for every table that has a NOT NULL
  `*_enc` column, no FK in `pg_constraint` references it with
  `confdeltype IN ('a','r')`. A future RESTRICT FK then fails CI instead of the
  04:00 run.

**Owner gates**

- **G2-1:** Yes/no: create a Telegram topic "ERP · Dev sync" in Homelab Alerts
  (Bot API `createForumTopic`) for `erp_dbsync`. If no, it stays in General.
- **G2-2:** Set `ALERT_URL` and `ALERT_TOKEN` on the **dev** `db-sync`
  service. Names only; the value is the relay's existing `ALERT_TOKEN`.

**Rollout and verification**

1. Merge to `dev`. db-sync builds from its root dir.
2. Check the next 04:00Z run logs `[sync] done` and `fleet restored`.
3. Read-only check on dev:
   - `SELECT count(*) FROM fleet_proxies` equals dev's own proxy count;
   - `SELECT max(created_at) FROM <a busy prod table>` is ≥ 2026-10-31.
4. Rollback: revert. The restore is one transaction, so a bad scrub only
   rolls back again.

### T3 — Backend: release held next-task polls on SIGTERM (P3)

| | |
| --- | --- |
| Closes | B1-07 |
| Versions under | ERP root, **patch** + CHANGELOG |
| Worker restart / FB login | None. The ERP backend restarts on its normal release; fleet workers just get an early `nothing_due` and re-poll the new instance |
| Effort | **S–M** |

**Change**

0. B1-07 is unverified. Before coding, confirm on Railway http logs
   (read-only) that the 502 bursts on `/api/fleet/worker/next-task` line up
   with the 10-31 15:23Z and 18:55Z deploys.
1. `apps/backend/src/fleet/claim.ts`
   - Add a module-level `let draining = false` and a `const drainSignal = new EventEmitter()`.
   - Export `releaseHeldPolls()`. It sets `draining = true` and emits on
     `drainSignal`.
   - In `armWake`, also subscribe to `drainSignal` and release on it.
   - In the next-task loop, after `wake.wait` and before holding again: when
     `draining`, return
     `{ task: null, retry_after: <2-5 s jitter>, reason: 'nothing_due' }`
     without the `pickTask` re-look. Also skip the hold entirely when
     `draining` is set at entry.
   - The worker already obeys `retry_after`, so the contract is unchanged.
2. `apps/backend/src/server.ts:71-72`: the SIGTERM and SIGINT handlers call
   `releaseHeldPolls()` next to `closeVncBridges()`, before `shutdown()`.
3. VNC 503s: no change in this ticket. `closeVncBridges()` already runs first,
   and the 2 ms 503s are viewers reconnecting before the new instance takes the
   relay lease. Record that in the ticket.

**Tests**

- `apps/backend/tests/fleet-claim.test.ts`: start a held next-task with
  `poll_hold_seconds` 30, call `releaseHeldPolls()`, and assert a
  `200 {reason:'nothing_due'}` within 1 s with `retry_after` ≤ 5.
- Same file: a new poll after draining returns at once.
- Reset the module flag between tests (export a test-only reset, or use
  `vi.resetModules`).

**Owner gates** — none.

**Rollout and verification**

- It ships with the next ERP release.
- On the following deploy, Railway http logs should show no 502 on
  `next-task`, and a burst of 200s at SIGTERM instead.
- Rollback: revert.

### T4 — Homelab Prometheus coverage: scrape the fleet host, make UPS alerts live, drop the dead bridge cron (P2)

| | |
| --- | --- |
| Closes | B4-04, B4-06, B4-08 |
| Versions under | none in this repo. The PR is to `JinhuW/homelab-monitoring`; this repo gets a docs-only ticket plus the erp-ops note |
| Worker restart / FB login | None. A Prometheus config reload and crontab edits only; no worker container is touched |
| Effort | **S** (+ owner time on hosts) |

**Change**

1. In `homelab-monitoring`, `prometheus.yml`, job `node_exporter`: add the
   target `10.10.60.14:9100`. Optionally add a `cadvisor` target on the same
   host if one runs; check with `ss -ltn` first.
2. Same repo, `ups_alerts` rules (B4-06):
   - Change `UPSExporterDown` to `up{job="cyberpower"} == 0 or absent(up{job="cyberpower"})`, `for: 10m`.
   - Then, as an owner choice, either re-add the `cyberpower` scrape job (where
     does the exporter run now?) or drop the UPS group.
   - Add a generic `TargetMissing` rule:
     `absent(up{job="node_exporter",instance="10.10.60.14:9100"})`. This is the
     same class of gap as the UPS one, so a removed target is caught next time.
3. B4-08: remove the `ai-verdict-bridge.py` and `fleet-log-follow.py` crontab
   lines on `worker@10.10.60.14` and check the homelab VM for the same lines.
   **Do not remove the withheld-alert sender.** Memory
   `fleet-ai-verdict-logs` says it stays until RS-455. Archive
   `~/fleet-ai-bridge/` rather than delete it.
4. This repo's `docs/agents/erp-ops.md`: one line saying 10.10.60.14 is
   scraped, and that the bridge crons are retired.

**Tests**

- `promtool check config prometheus.yml`.
- `promtool test rules` with a case that has no `cyberpower` series and
  expects `UPSExporterDown` firing, plus a case with a missing 60.14 target.
- Port from the `docs/review-2026-10-31/repro/B4-verify/commands.md` target
  and rule queries as read-only post-checks.

**Owner gates**

- **G4-1:** Rsync the merged homelab-monitoring tree to
  `/srv/homelab_monitoring` on `ubuntu@10.10.60.5` and reload Prometheus with
  `POST /-/reload` or a container restart. This is not a fleet restart.
  Confirm the route from 10.10.60.5 to 10.10.60.14:9100 first with a `curl`
  from 10.10.60.5.
- **G4-2:** Yes/no on the UPS: re-add the exporter, or drop the rules?
- **G4-3:** Edit the crontab on 10.10.60.14, and on the VM if the lines are
  there. Not a login.

**Rollout and verification**

- `curl 10.10.60.5:9090/api/v1/targets` shows `10.10.60.14:9100` with
  `health=up`.
- `/api/v1/rules` shows `ServerDown` evaluating for that instance.
- `crontab -l` on 10.10.60.14 has no `fleet-ai-bridge` lines.
- Rollback: revert the homelab-monitoring commit and rsync again.

### T5 — Fleet agent prunes superseded images after a release (P3)

| | |
| --- | --- |
| Closes | B4-10 |
| Versions under | ERP root, **patch** (`apps/fleet-agent`), shipped as an agent image through `fleet-images.yml` |
| Worker restart / FB login | The agent swap itself does not recreate worker containers. It **must ride WS-A's B4-01 agent upgrade** (one agent rollout, not two), and pruning never touches an image a container uses |
| Effort | **S–M** |

**Change**

1. `apps/fleet-agent/src/docker.ts`: add `pruneImages(keep: string[])`. It
   lists images of the worker and agent repos (`docker image ls --format json`)
   and removes each one not referenced by **any** container, running or
   exited, and not in `keep`. The `keep` list is the current tag plus the
   previous tag, for rollback.
2. `apps/fleet-agent/src/agent.ts`: once a release has completed (every slot
   reports the new image healthy), call `pruneImages`. Failures are logged
   through `log.ts` and never fail the release.
3. The exited `rs-fleet-worker-60-14-2` pins 0.14.7 through rule 1 until
   **WS-A** B4-07 removes it.

**Tests**

- `apps/fleet-agent/tests/docker.test.ts`: with a fake docker that has images
  A (used by an exited container), B (current), C (previous) and D (unused),
  only D is removed.
- `agent.test.ts`: prune runs only after a completed release, and an error is
  swallowed.

**Owner gates**

- **G5-1:** Yes/no: a one-off manual
  `docker image prune -a --filter until=168h` on 10.10.60.14 now, to reclaim
  about 13 GB? It removes only images no container uses, so it is not a login.
  The disk is at 23%, so this is optional.
- The agent rollout itself is WS-A's gate.

**Rollout and verification**

- After the next fleet release, `docker system df` on 10.10.60.14 shows
  reclaimable space under 3 GB and two worker tags left.
- Rollback: the agent's previous tag.

### T6 — Scheduled-job hygiene: nightly Railway routine and the dead keyword-eval (P3)

| | |
| --- | --- |
| Closes | B4-03, B5-03 |
| Versions under | none. Docs-only in this repo (the `erp-ops.md` *Scheduled jobs* table); the rest are owner actions |
| Worker restart / FB login | None. keyword-eval only reads `docker logs`, and unloading it starts nothing |
| Effort | **S** |

**Change**

1. B4-03, the RemoteTrigger `trig_01W3wmHwWNUGr63STjr9e5UT`, through the
   `RemoteTrigger` update with the owner's yes. Change the prompt so that:
   - its first step is
     `git fetch origin dev inspection-reports && git rev-parse origin/dev`;
   - a run that cannot reach `backboard.railway.com` or has no `RAILWAY_*`
     token **ends as a failure**. It must not write a "blocked" report and
     return success. It should send a push titled `BLOCKED: nightly Railway inspection`.
   - Memory `railway-routine-needs-env-token` already records the env gap.
2. B5-03: **retire** the job rather than repoint it. AI verdicts already live
   in OpenSearch `fb-tracker-*` (memory `fleet-ai-verdict-logs`), and a
   keyword review rebuilt on that belongs in `trackers/facebook/` as a new
   ticket if the owner still wants it.
   - The job lives in the legacy checkout
     `~/Projects/recycle_servers/facebook_tracker`, outside this repo, so this
     is an owner action. Do it in the same session as **WS-A**'s B5-01 and
     B5-02 unloads (fbmonitor, search-probe in the same checkout).
   - **WS-C**'s B5-04 then archives that checkout.
3. `docs/agents/erp-ops.md`: add a *Scheduled jobs* table. Each row lists the
   job, where it runs, its schedule, and **how its failure alerts**:
   - uptime-monitor: dead-man `erp_uptime`;
   - db-sync: `/alert` + dead-man `erp_dbsync`;
   - pg-r2-backup: Railway webhook / WS-C;
   - the nightly routine: push on BLOCKED;
   - Prometheus;
   - memtrade.

   A job with no alert path is a defect.

**Tests** — none in code. The regression check is the next routine run:
`get_run_log` shows a `get-logs` call that returned data and a successful
`git rev-parse origin/dev`. For keyword-eval, the
`launchctl print gui/501/com.recycleservers.keyword-eval` label is gone.

**Owner gates**

- **G6-1:** Add a read-only `RAILWAY_API_TOKEN` (name only) as a network
  secret in env `env_01LUc7Gka7hUDXMtor55tYnf`, and allow
  `backboard.railway.com` in its egress allowlist.
- **G6-2:** Yes/no: may an agent update the routine prompt as described?
- **G6-3:** Yes/no: retire keyword-eval:
  - `launchctl bootout gui/501/com.recycleservers.keyword-eval`, then move its
    plist out of `~/Library/LaunchAgents`;
  - revoke the long-lived Claude OAuth token behind that checkout's
    `.claude-oauth-token` in the Claude account settings, then delete the
    file.

**Rollout and verification** — as in Tests. Rollback: re-bootstrap the plist
(not advised), or revert the prompt.

### T7 — Railway config hygiene: reddit deploy provenance, dormant projects, env drift (P3)

| | |
| --- | --- |
| Closes | B1-09, B1-10, B1-11 |
| Versions under | Two PRs. **T7a**: `trackers/reddit` (SHA-tagged, no release). **T7b**: ERP root **patch** (`apps/backend/scripts/init-admin.mjs`) + root `AGENTS.md` |
| Worker restart / FB login | None. The reddit api/worker have no Facebook sessions |
| Effort | **S** each |

**Change**

- **T7a, B1-09.** `railway up` uploads carry no commit.
  - Add `trackers/reddit/scripts/deploy-api.sh`. It writes
    `git rev-parse HEAD` (plus `-dirty`) to `trackers/reddit/.build-sha`
    (gitignored), then runs `railway up --service "$1" --detach`.
  - The Dockerfile copies `.build-sha`.
  - `src/api.ts:58` `/health` and the worker's boot log report `commit`.
  - Point `trackers/reddit/README.md:353` at the script.
  - Service-level `healthcheckPath=/health` and `drainingSeconds` are owner
    gate G7-1, since the shared `railway.toml` serves both services.
- **T7b, B1-11.** `Dockerfile:68` runs `init-admin.mjs` on every boot.
  - Removing `ADMIN_PASSWORD` from prod as proposed would therefore *fail
    boot* if the `ADMIN_EMAIL` user were ever missing. That path exits 1 on
    the default password in production.
  - Change `init-admin.mjs`: in production with `ADMIN_PASSWORD` unset, log
    `admin provisioning skipped` and exit 0. Do that before removing the
    variable.
  - Root `AGENTS.md` *Contracts*: mark `COORDINATOR_ACCESS_CLIENT_ID`/`_SECRET`
    "required once fbc-api is behind Access (WS-C B2-01), optional until".
    **Do not** call them simply optional, because WS-C is about to make them
    required.
  - `docs/FEATURES.md` or erp-ops: record that dev's fleet mirror pages read
    the local copy, since no `FLEET_MIRROR_*` is set on dev.
- **B1-10**: owner actions only (G7-3).

**Tests**

- T7a: `trackers/reddit/tests/api.test.ts` (or the existing health test):
  `/health` includes `commit`, read from an env or file stub. Run with
  `cd trackers/reddit && pnpm test`, because root CI doesn't reach it.
- T7b: `apps/backend/tests/` has no init-admin test today. Add
  `init-admin.test.ts`, which spawns the script against the test DB with
  `NODE_ENV=production` and no `ADMIN_PASSWORD`, and expects exit 0 with no
  user created.

**Owner gates**

- **G7-1:** Set `healthcheckPath=/health` and `drainingSeconds=35` on
  `reddits-tracker/production/api` (service settings).
- **G7-2:** After T7b is on `main`, remove the variables `FLEET_IMAGE_AGENT`
  (prod and dev) and `ADMIN_PASSWORD` (prod and dev) from the backend
  service. Yes/no: set the `FLEET_MIRROR_*` trio on dev, or keep local-copy
  mode?
- **G7-3 (B1-10):** Yes/no for each:
  - delete the `ebay-tracker` project, or at least rotate its Postgres
    password, which is part of **WS-C**'s post-breach rotation (B1-02 is the
    same class);
  - delete `recycle-odoo`;
  - discard the `aio-manufacturing-solution` staged patch `0f1cd121`.

**Rollout and verification**

- T7a: the next `deploy-api.sh` run shows `commit` in `/health`.
- T7b: the next prod boot logs `admin already exists, skipping` or `skipped`.
  After G7-2, `railway variables` lists neither name.
- B1-10: `list-projects` no longer shows the dormant ones.
- Rollback: revert, or re-add the variable.

## 3. Order

| # | Ticket | Why here |
| --- | --- | --- |
| 0 | **G1-0** (owner, today) | P1: prod is unmonitored. No code needed to restore the cron |
| 1 | T2 | S; dev has been frozen since 10-27. Its `/alert` post works on today's relay |
| 2 | T1 | P1 code; the relay deploy also enables T2's heartbeat watch |
| 3 | T4 | P2; independent of ERP code, owner-paced |
| 4 | T6 | Docs plus owner actions. The *Scheduled jobs* table lands after T1 and T2 so it describes the real alert paths |
| 5 | T3 | P3 backend, any release |
| 6 | T7a / T7b | P3. T7b's AGENTS.md line follows WS-C's decision on Access |
| 7 | T5 | Waits on WS-A's B4-01 agent upgrade, in the same agent rollout |

Cross-workstream dependencies:

- **WS-A**:
  - B4-01 agent upgrade carries T5;
  - B4-07 frees the 0.14.7 image;
  - B5-01 and B5-02 legacy Mac unloads go in the same session as T6's
    keyword-eval retirement.
- **WS-C**:
  - the Cloudflare WAF skip rule in Terraform (G1-2);
  - B2-01 Access on fbc-api sets T7b's wording;
  - B1-02 and B1-10 credential rotation;
  - B5-04 archives the legacy checkout after T6.
- **WS-D**: A11-10 shares the uptime-monitor branch setting. WS-B does the
  switch (G1-4).
- **WS-H**: owns B4-09 (below).
- **WS-I**: C2-03 (backup docs call pg-r2-backup "db-sync") should use the
  names in T6's table.

## 4. Dropped / deferred

| Finding | Disposition | Reason |
| --- | --- | --- |
| B4-09 | **Deferred to WS-H** | Same defect as WS-H's A9-09 (`trackers/reddit/scripts/deploy-workers.sh:58` interpolates `GHCR_READ_TOKEN` into the ssh command). Still present on f0c1d856. One fix belongs with the reddit tracker's deploy work: pipe it over stdin (`printf '%s' "$GHCR_READ_TOKEN" \| ssh … "sudo docker login ghcr.io -u … --password-stdin"`), plus a shellcheck/grep guard. |

## Owner-gate count

There are 17 gates, and G1-0 is urgent:

- T1: G1-0, G1-1, G1-2, G1-3, G1-4
- T2: G2-1, G2-2
- T4: G4-1, G4-2, G4-3
- T5: G5-1
- T6: G6-1, G6-2, G6-3
- T7: G7-1, G7-2, G7-3
