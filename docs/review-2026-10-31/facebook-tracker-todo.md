# Facebook tracker — review 2026-10-31

Lanes: A10 (Facebook tracker). 42 findings: 1 P1 / 9 P2 / 32 P3. Severity shown is after verification; P3s were not verified.

## P1

- [ ] **A10-01 / P1 / confirmed: The coordinator's master secrets go to every container that reads secrets.env; live, the internet-facing rs-console holds the vault key, worker-token secret and coordinator DB URL**
  - Location: `trackers/facebook/deploy/docker-compose.console.yml:29-30; deploy/docker-compose.fleetd.yml:52,61; deploy/docker-compose.messenger.yml:37; deploy/docker-compose.poster.yml:36; configs/secrets.env.example:111-121; live container rs-console on 10.10.10.73`
  - Evidence: secrets.env carries RS_VAULT_KEY, RS_WORKER_TOKEN_SECRET, RS_ADMIN_TOKEN, RS_CONSOLE_TOKEN and the DB URL. The console, messenger, poster and rs-router compose files all env_file it, and rs_fleetd passes it to every worker as --env-file (fleetd.yml:52). Checked by variable name only: `docker inspect rs-console` shows RS_VAULT_KEY, RS_WORKER_TOKEN_SECRET and RS_DATABASE_URL set. `grep` finds none of the three anywhere in rs_console/rs_console/. fleetd.yml:24 keeps the host token out of secrets.env 'because every worker gets that file', yet host tokens are HMACs of RS_WORKER_TOKEN_SECRET, which is in it. The live fleet-mode workers (TS fleet-agent) do not carry these names.
  - Failure: rs-console parses ERP traffic and relays VNC websockets behind the Cloudflare tunnel. An RCE or SSRF-to-env in it, or `docker inspect` access on the VM, yields the key that decrypts every account's password and TOTP, the secret that mints any worker or host token, and direct DB access. That is the whole vault, from the one service designed to be 'read-mostly'.
  - Fix: Split secrets.env: secrets.coordinator.env (vault key, token secret, admin token, DB URL) for the coordinator only; a console file holding RS_CONSOLE_TOKEN plus the admin token it forwards with; a workers' file. Then rotate RS_VAULT_KEY (re-encrypt) and RS_WORKER_TOKEN_SECRET. Recreating the console is not a login; worker recreation is, so plan that rotation with the owner.
  - Regression test: A test in rs_console or scripts/tests that parses every deploy/*.yml and fails if a service other than the coordinator env_files a file listed as coordinator-only.
  - Verifier: ssh 10.10.10.73 docker inspect rs-console (env NAMES only, cut -d= -f1): RS_ADMIN_TOKEN, RS_VAULT_KEY, RS_WORKER_TOKEN_SECRET, RS_CONSOLE_TOKEN, RS_DATABASE_URL present. Source: deploy/docker-compose.console.yml:29-30 env_file ../configs/secrets.env, which secrets.env.example:111-121 says holds the vault key, the worker-token secret and the admin token. The container's compose label is /home/jinhu/recycle_servers/facebook_tracker/deploy/docker-compose.console.yml. Fleet workers (rs-fleet-homelab-1) and rs-fleet-agent carry only a host token, so the exposure is the console plus rs-coordinator. (The internet-facing (tunnelled) facade holds every master secret. A console compromise or docker-inspect access yields the vault key, the token-minting secret and DB access. P1 stands.)

## P2

- [ ] **A10-02 / P2 / confirmed: deploy.sh, AGENTS.md and README describe a VM topology that no longer exists; a deploy now 'verifies' zero workers and posts 'verified' to Telegram**
  - Location: `trackers/facebook/scripts/deploy.sh:71-73,78-85,182-210,383-416,431-435; trackers/facebook/AGENTS.md 'Versioning, releases, deploys'; VM 10.10.10.73 docker ps`
  - Evidence: The VM (docker ps, read-only) has no rs-fleetd container and no compose workers. Nine rs-fleet-homelab-* workers run ghcr.io/jinhuw/aimm-recycle:0.15.0 under the TS rs-fleet-agent (apps/fleet-agent, --restart no). All deploy/docker-compose.homelab*.yml files were deleted (#935-#951). deploy.sh's fleet_mode() checks `docker inspect rs-fleetd`, gets false, and falls to compose mode. homelab_workers() then globs nothing, and verify() loops over zero workers and prints 'verified: every worker and the coordinator run this tree'. The VM stamp .rs-deployed says 0.13.18 (2026-10-24). The VM tree's VERSION is 0.13.18, rs_coordinator/pyproject says 0.14.4 and rs_console says 0.14.16, yet `rsync -nci` shows the code identical to 0.15.0 except those version lines. Deploys have been done by hand since.
  - Failure: An operator who follows AGENTS.md runs deploy.sh. It force-recreates the coordinator and the console, builds an aimm-recycle:latest image nothing uses, and reports to the Releases topic that the version is on '0 workers - verified running this tree'. The fleet stays on whatever GHCR tag the ERP released. Meanwhile /healthz versions (0.14.x) disagree with the code, so version-based drift checks give wrong answers. AGENTS.md also still says to use `rsc fleet release`, which now drives an agent that is not running.
  - Fix: Retire or rewrite deploy.sh for the current split: coordinator and console only, workers via push-fleet-images.sh plus the ERP's POST /api/fleet/releases. Make verify fail when it found zero workers. Update AGENTS.md/README/deploy/README.md. Stamp the VM's VERSION and pyprojects consistently (needs owner).
  - Regression test: test: run deploy.sh's verify with an empty homelab_workers list and assert a non-zero exit.
  - Verifier: Live: `docker inspect rs-fleetd` rc=1, so fleet_mode() is false, and no deploy/docker-compose.homelab*.yml exists in the repo or on the VM. repro/A10-verify/a10-02-homelab-workers.sh runs deploy.sh's own homelab_workers() under set -eu and prints: verify loop iterations=0, WORKER_COUNT=0, restart loop does nothing (a10-02-homelab-workers.out). So verify() checks no worker, and the notify step posts 'to the coordinator and 0 workers - verified running this tree'. rs-coordinator /healthz reports version 0.14.4 while VERSION is 0.15.0, and the workers run ghcr.io/jinhuw/aimm-recycle:0.15.0 under rs-fleet-agent:1.380.1 (not rs-fleetd). AGENTS.md:117 and README.md:355 still prescribe `rsc fleet release`. (The documented deploy path verifies nothing and still force-recreates the console and coordinator (deploy.sh:309).)

- [ ] **A10-04 / P2 / confirmed: A seeded pool cookie (cookie-first Assign) is overwritten by the slot's previous login's backup, and the restore the ERP queued then 409s; the worker falls back to a password login**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/session.py:151-215 (backup_session), 219-282 (seed_session); db.py:2059-2069 / pg.py:1316-1328 (upsert_snapshot)`
  - Evidence: backup_session accepts any jar with an xs cookie. When its uid is not the slot account's, _session_identity returns None. upsert_snapshot then replaces the row unconditionally, including the snapshot seed_session just sealed. session.py:100-103 itself says the previous login's session is 'still being saved while a swap's re-login is on its way'. Reproduced in docs/review-2026-10-31/repro/A10/test_seed_overwritten_by_stale_backup.py, which passes: after seed + stale backup, fb_user_id is the old uid and restore returns 409. Also, with the legacy fleet token, backup_session takes worker_id from the body (session.py:158), so any legacy-token holder can replace any worker's snapshot.
  - Failure: The ERP assigns a pool account by cookie: PUT /session, then POST /restore-session. The worker's periodic backup of the old login lands first, and the seeded cookie is lost. The restore is refused, so the worker logs in by password + 2FA. That is the checkpoint-prone path the cookie-first assign exists to avoid.
  - Fix: In backup_session, when the slot's account has a uid and the incoming session's uid differs, refuse with 409 (or store it in a side column), never replacing a restorable snapshot. Require require_own_worker semantics (no legacy token) for backups.
  - Regression test: The repro test above, inverted: assert the stale backup is refused and restore still returns 200.
  - Verifier: repro/A10-verify/test_a10_04_seed_overwritten.py passes (test_a10_04.out). Old login backed up, slot remapped to a new uid, PUT /v1/workers/denver-1/session seeds the new cookie and the restore answers 200. Then the worker's backup of its old-login browser is accepted (200) and replaces the seed, because upsert_snapshot (db.py:2059, pg.py:1316) is an unconditional ON CONFLICT DO UPDATE. GET restore then answers 409. (backup_session never checks whether the incoming session matches the slot's current identity before overwriting a seeded snapshot. The ERP flow (facebookPool.ts:680-689) seeds then restores, so the window is real.)

- [ ] **A10-05 / P2 / confirmed: Telegram MarkdownV2 escaping omits the backslash and truncates after escaping; such an alert fails with 400 and is retried forever**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/telegram_notify.py:18-22,69; background.py:151-153`
  - Evidence: _MARKDOWN_V2_SPECIALS = r"_*[]()~`>#+-=|{}.!" has no '\'. send() posts text[:4096] of already-escaped text with parse_mode MarkdownV2.
  - Failure: A seller title ending in '\' (e.g. 'R730 64GB\') escapes the template's closing '*'. Telegram answers 400 'can't find end of Bold entity'. The outbox retries every 15 min forever, the listing is stored as seen, and the buy lead is never alerted. A 4096-char cut through an escape pair does the same.
  - Fix: Escape '\' first. Truncate raw fields before escaping. On a 400 parse error, resend without parse_mode or mark the row dead with an ops note.
  - Regression test: test_telegram_notify: escape_markdown('a\\') round-trip; a 5000-char title produces valid MarkdownV2.
  - Verifier: repro/A10-verify/a10_05_markdown_escape.py (a10_05.out): escape_markdown('a\\b') returns it unchanged. format_listing with title 'R730 64GB\\' gives first line '*New match: R730 64GB\\*' with 3 unescaped '*' (an unclosed bold). A 5000-char ai_comment cut at 4096 ends in a dangling '\\'. background.py:151-153 marks a failure and reschedules with backoff_seconds capped, and due_alerts has no attempts limit, so it retries forever. Not sent to Telegram (forbidden), so the 400 itself is inferred from the MarkdownV2 spec. (Backslash is a MarkdownV2 special that must be escaped. The listing is already claimed, so the lead is never alerted.)

- [ ] **A10-06 / P2 / confirmed: Nothing enforces one account per worker; the CLI skips the API's 409**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/db.py:397,1970; pg.py:1222; cli.py:390; routers/accounts.py:147-155`
  - Evidence: accounts.worker_id has no unique index. account_row_for_worker is `SELECT * ... WHERE worker_id = ?` + fetchone() with no ORDER BY. The API's check-then-write 409 is racy, and `rsc vault set-account --worker` performs no check.
  - Failure: Two rows map to va-1. On Postgres, which row comes back can change after any UPDATE. The worker is then handed the other account's password or TOTP, identity and restore checks run against the wrong uid, and a login under the wrong device follows.
  - Fix: Partial unique index on accounts(worker_id) WHERE worker_id IS NOT NULL in both backends, after a dedupe. The CLI refuses like the API.
  - Regression test: test_accounts: second set-account for the same worker via CLI raises; DB-level unique violation test.
  - Verifier: repro/A10-verify/test_a10_06_two_accounts_one_worker.py (test_a10_06.out): AccountStore.put_account (the call cli.py:390 makes) maps acct-a and acct-b both to va-1, and account_row_for_worker returns acct-a. The API path PUT /v1/accounts/acct-b answers 409. The schema (db.py:397) has no UNIQUE on accounts.worker_id. The API check (accounts.py:147-155) is also read-then-write, not atomic. (Only the API guards it, non-atomically. Prod data not checked for existing duplicates (an aggregate read-only query was not run; see needs_owner).)

- [ ] **A10-08 / P2 / confirmed: Concurrent incident reports lose votes and can page DOWN twice**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/incidents.py:37-46`
  - Evidence: get_incident, then incidents.apply in Python, then a blind save_incident upsert, with no lock on either backend.
  - Failure: An AI-provider outage makes the whole fleet report 'down' within seconds. Two handlers both see 'closed' and both page DOWN. The last writer's reporters JSON wins, so a later single 'up' closes the incident and pages 'recovered' while workers whose votes were lost are still down, and they never re-vote.
  - Fix: Serialize with a process lock (as city_queue._handout does) or SELECT ... FOR UPDATE on Postgres.
  - Regression test: Threaded test posting N concurrent 'down' reports; assert one page and N reporters.
  - Verifier: repro/A10-verify/test_a10_08_incident_race.py (test_a10_08.out) replays the handler's get_incident -> incidents.apply -> save_incident (incidents.py:37-46) for two interleaved 'down' reports: both page DOWN, only va-2's vote survives, and va-2's later 'up' closes the incident and pages 'recovered' while va-1 is still down. The handler is a sync def, run concurrently in FastAPI's threadpool, with no row lock or transaction around the read-modify-write. Workers report only on crossings, so the lost voter never re-votes. (Deterministic replay of the interleaving, not a timed race. The logic leaves nothing to prevent it.)

- [ ] **A10-09 / P2 / confirmed: A worker with no account mapping can lock any account it names**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/escalation.py:47-60,108-112`
  - Evidence: _account_for falls back to payload.account_id when resolve_account fails. A challenge with kind=='locked' then runs db.lock_account(account_id).
  - Failure: A freshly provisioned or detached worker (or a compromised one) posts {kind:'locked', account_id:<any>}. From then on no worker is handed that account's password until `rsc vault unlock`, and the healthy account silently drops out of the fleet.
  - Fix: Lock only the account resolved from the worker's own mapping; keep the claimed id only as challenge metadata.
  - Regression test: test_escalation: unmapped worker posting locked for account X leaves X unlocked.
  - Verifier: repro/A10-verify/test_a10_09_unmapped_lock.py (test_a10_09.out): worker fresh-9 has no account. It POSTs /v1/auth/escalate {kind:'locked', account_id:'victim'} with its own valid token and gets 200, and victim (mapped to va-1) now has locked_at set, reason 'Facebook lock page'. escalation.py:47-60 falls back to the claimed account_id, and :108-112 locks it. (The fallback that keeps an unmapped worker's escalation is also applied to the destructive lock.)

- [ ] **A10-10 / P2 / confirmed: A listing whose alert enqueue fails is stored as seen and never alerted**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/listings.py:105-128,159-180`
  - Evidence: claim_listing/update_listing commit in one call. enqueue_alert runs later in a separate call. An exception between them only counts the listing as 'failed'.
  - Failure: A DB blip or pool timeout between claim and enqueue leaves the listing committed. Every later sighting is a DUPLICATE, so the lead is lost. For a DISCOUNTED listing the new price is already stored, so the drop can't be detected again.
  - Fix: Claim/update and enqueue in one transaction, or a reconciler that alerts listings with no outbox row.
  - Regression test: test_outbox: make enqueue_alert raise once; assert a retry or the next sighting still alerts.
  - Verifier: repro/A10-verify/test_a10_10_enqueue_failure.py (test_a10_10.out): with enqueue_alert raising once, the first report returns {failed:1}, the worker's retry returns {duplicates:1, queued:0}, and Telegram sends = 0. claim_listing commits before the enqueue (listings.py:105-128,159-180), and nothing re-enqueues listings with notified_at IS NULL (grep finds no such reconcile). (Claim and enqueue are not one transaction, and there is no sweep for unalerted listings.)

- [ ] **A10-11 / P2 / confirmed: Settings save writes some worker configs, fails on a fleet write, and leaves settings.json on the old values**
  - Location: `trackers/facebook/rs_console/rs_console/settings.py:534-538; app.py:850-857`
  - Evidence: apply() renders everything first, then writes the mounted files and then fleet configs one by one (fleet.write). A FleetError (OSError) on worker N becomes a 500 in put_settings before settings.save(state) runs.
  - Failure: During a coordinator blip the ERP reports 'save failed', yet some workers already search with the new keywords or cities while the saved state and /v1/fleet show the old ones. The next render (deploy, or the next save) silently reverts those workers.
  - Fix: Save the state before the fleet writes, or continue past failed fleet writes and return the failures with the state saved.
  - Regression test: test_settings: fleet.write raises on the 2nd worker; assert settings.json carries the new values and the response lists the failure.
  - Verifier: repro/A10-verify/a10_11_partial_fleet_write.py (a10_11.out): settings.apply writes fleet configs in order. With va-2's write raising FleetError, va-1 is already written. FleetError subclasses OSError (settings.py:359), so app.py:850-857 returns 500 'A worker config could not be written' before settings.save(state), and settings.json keeps the old values. Live console has RS_WORKER_CONFIGS='' so all targets are fleet (remote) writes, which is the failing kind. (No rollback and no save of the partial state. The next render from saved state reverts the workers that took the new values.)

- [ ] **A10-12 / P2 / confirmed: A blocking coordinator call inside the async VNC/fleet handlers, behind a threading.Lock, stalls the whole console; an unauthenticated websocket can trigger it**
  - Location: `trackers/facebook/rs_console/rs_console/app.py:475-503,538-541,718; settings.py:379-382`
  - Evidence: _fleet_vnc_targets() calls fleet.state() (a sync httpx call, 10 s timeout) under threading.Lock every 30 s when its cache expires. It is called from async def vnc_socket before the ticket is checked (line 539), and from the /v1/fleet builder.
  - Failure: With a slow coordinator, every cache refresh freezes the event loop for up to 10 s. Live VNC bridges stall and the ERP's proxied reads time out. Anyone who can reach the console's websocket can trigger a refresh without a token.
  - Fix: Use await asyncio.to_thread(_vnc_targets), or an async client with asyncio.Lock, and check the ticket is present before resolving targets.
  - Regression test: Async test with a fake fleet that sleeps 2 s: a concurrent /healthz must answer in well under 2 s.
  - Verifier: repro/A10-verify/a10_12_event_loop_stall.py (a10_12.out) runs uvicorn rs_console.app against a coordinator that accepts and never answers. /healthz baseline is 0.00s. With one websocket to /v1/vnc/va-1/ws with NO ticket open, /healthz takes 9.51s, and the ws is then refused. vnc_socket (async, app.py:538-541) calls _vnc_targets() before the ticket check, which runs the blocking httpx FleetConfigs.state() (settings.py:379-382, timeout 10s) under threading.Lock on the event loop. /v1/fleet (async, app.py:718 _vnc_pages()) does the same. (Reproduced the stall from an unauthenticated socket. Reachability from the internet depends on the Cloudflare Access policy in front of the tunnel, which was not checked.)

## P3

- [ ] **A10-03 / P3 (raised as P2) / confirmed: deploy.sh never checks the vendored monitor against VENDOR.md; it ships and builds whatever clone is on disk**
  - Location: `trackers/facebook/scripts/deploy.sh:237-238,279-294,339-344; scripts/check-release-tag.sh:44`
  - Evidence: release.sh:104 runs check-vendor.sh, and so does push-fleet-images.sh:69-72. deploy.sh does not (grep finds no call). check-release-tag.sh's `git status --porcelain -- .` ignores the gitignored ai-marketplace-monitor/. deploy.sh then rsyncs ai-marketplace-monitor and builds the worker image from it. verify_worker compares the container against the same local clone, so a drifted clone reads MATCH.
  - Failure: A deploy from a worktree whose clone sits on a different commit, or carries uncommitted edits, ships an unpinned monitor under a valid release tag. Today's worktrees show four different clone HEADs (gar-2 ac161ad, milkfish f4d4fdf, telescopefish 93e2566, pin 3576db7). The Releases log then names a version whose engine nobody can reconstruct, which is the 'lost pin' incident of 2026-10-23 again.
  - Fix: Call `sh scripts/check-vendor.sh` in deploy.sh's version gate, before the rsync.
  - Regression test: scripts/tests: fixture repo with a vendored clone off-pin; assert deploy.sh's gate step refuses.
  - Verifier: `grep check-vendor scripts/deploy.sh` finds nothing. deploy.sh:279-294 rsyncs ai-marketplace-monitor as it is on disk. check-release-tag.sh:44 runs `git status --porcelain -- .`, which cannot see the gitignored clone. But scripts/push-fleet-images.sh:66-72 does refuse a HEAD != VENDOR.md pin and a dirty clone, and that script builds the GHCR aimm-recycle image the fleet actually runs (live workers: ghcr.io/jinhuw/aimm-recycle:0.15.0). (The gap is real, but only in deploy.sh, whose locally built aimm-recycle image no live worker uses (see A10-02). The fleet's image path is pinned, so an unpinned engine cannot reach the fleet this way today.)

- [ ] **A10-07 / P3 (raised as P2) / confirmed: Any worker token can ack another worker's queued Messenger reply, and fetch has no claim/lease, so replies can be dropped or sent twice**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/messages.py:139-176`
  - Evidence: ack_outbound ignores the authenticated worker and only checks that the id exists (lines 163-176). fetch_outbound is a plain SELECT of status='queued'. With the legacy token and no worker_id it returns every worker's queue. Matrix replies have worker_id NULL.
  - Failure: Two rs-router pollers, or a slow ack overlapping the next poll, both send the same staff reply to a seller. Or a buggy or compromised worker acks someone else's reply as sent and it is silently lost.
  - Fix: ack requires worker == row.worker_id. Fetch claims atomically (UPDATE ... SET status='sending', claimed_at ... RETURNING) with a lease that expires back to queued.
  - Regression test: test_messages: worker B acking A's row gets 403; two concurrent fetches return disjoint rows.
  - Verifier: repro/A10-verify/test_a10_07_outbound_ack.py (test_a10_07.out): two polls before an ack both return outbound id 1 (no claim/lease). A va-9 token acks va-1's reply as sent (200), and va-1 then fetches nothing. ack_outbound (messages.py:162-176) ignores the caller identity. Live VM `docker ps`: no rs-messenger, rs-router or conduit container is running. (The defect is real, but no messenger bridge runs today, and double-send needs two pollers for one worker/transport. Lowered to P3 until the bridge is deployed.)

- [ ] **A10-13 / P3 (raised as P2) / plausible: A worker-supplied vnc_url is rendered as a clickable href with no scheme check**
  - Location: `trackers/facebook/rs_console/rs_console/static/fleet.js:81-84,349,366,470,667-668; rs_coordinator/routers/health.py:64; schemas.py:212`
  - Evidence: The heartbeat stores payload.vnc_url, a free str, as given. /v1/fleet passes it through, and fleet.js uses w.vnc_url ?? ... as an href after esc(), which escapes HTML but not URL schemes. On challenge rows ch.vnc_url wins over the console's own viewer.
  - Failure: A compromised worker heartbeats vnc_url 'javascript:...'. An operator clicks Watch on the console page, where the console token sits in localStorage. Whether it executes depends on browser handling of target=_blank/noopener, so this is a path, not a demonstrated exploit. The ERP's React page consumes the same field.
  - Fix: Accept only http(s) or same-origin /vnc/ URLs, both at heartbeat time on the coordinator and in watchButton. Prefer vncFor() over ch.vnc_url.
  - Regression test: test_coordinator: heartbeat with javascript: vnc_url is rejected (422).
  - Verifier: fleet.js:81-84 watchButton writes href="${esc(url)}" with no scheme check. The challenge path uses ch.vnc_url, which resolve_vnc_url (escalation.py:142-157) takes straight from the worker row the heartbeat writes (health.py:64, schemas.py:212 plain str). esc() is HTML-escaping, so 'javascript:' survives. Not executed in a browser. (It needs a compromised worker token plus an operator click, and with target=_blank rel=noopener a javascript: URL does not run in the console origin in current Chromium. Defence-in-depth, P3.)

- [ ] **A10-15 / P3 (raised as P2) / confirmed: The poster/messenger account lock checks liveness by PID across separate containers' PID namespaces**
  - Location: `trackers/facebook/rs_poster/rs_poster/session.py:41-59,77-93; deploy/Dockerfile.messenger:25; tests/test_poster.py:225-232`
  - Evidence: The lock stores os.getpid() and tests liveness with os.kill(pid, 0). Poster and messenger run in different containers, each with tini as PID 1, so PIDs are small, collide, and are meaningless across namespaces. Stale-break is unlink-then-create, which races, and finally unlinks even a lock this process no longer owns.
  - Failure: A messenger killed while holding the lock restarts with the same PID, sees 'itself' alive and exits with SessionLockedError, and the bridge stays down until someone deletes account.lock. Or the other container sees 'no such process' and breaks a live lock, so poster and messenger drive one Facebook account at once, which is the very thing the lock exists to prevent.
  - Fix: fcntl.flock on the lock file in the shared volume: the kernel releases it when the holder dies, across containers on one host.
  - Regression test: Test: two processes with different PID namespaces simulated via a stub os.kill; assert a held flock blocks and a dead holder frees it.
  - Verifier: session.py:41-59 probes liveness with os.kill(pid,0) on a PID from a file on a volume shared by two containers (docker-compose.messenger.yml:44 / poster.yml:40 FB_LOCK=/data/account.lock), each with its own PID namespace (tini as PID 1, so small deterministic PIDs). The existing rs_poster/tests/test_poster.py:225-232 already shows the self-PID case: a lock holding the caller's own PID raises SessionLockedError. Live VM: neither rs-poster nor rs-messenger is running. (The mechanism is real, but neither container runs today and messenger is restart:'no'. Lowered to P3.)

- [ ] **A10-17 / P3 (raised as P2) / plausible: browse-session.py saves the session every 5 s without a logged-in guard, proxy fallback, device identity or lock**
  - Location: `trackers/facebook/scripts/browse-session.py:33-47,64`
  - Evidence: ctx.storage_state(path=sess) runs every 5 s with no xs/is_logged_in check, which is the bug session.py:231-241 guards against. The write is not atomic and has no indexed_db. The proxy comes only from --proxy, and there is no identity.json or account_lock.
  - Failure: A checkpoint or logout while warming a session, or a forgotten --proxy, overwrites a good saved session with a logged-out jar or replays it from the operator's IP. Rebuilding costs a password + 2FA login.
  - Fix: Reuse PosterSession (device_context_options and proxy_settings from the sidecar). Save via atomic_write_text only when xs is present. Take the account lock.
  - Regression test: Unit test with a fake context whose cookies lack xs: assert the file is unchanged.
  - Verifier: browse-session.py:33-47,64: save() writes ctx.storage_state over the session file every 5 s, unconditionally (no xs/logged-in check, no account lock). --proxy is optional and not read from the .meta.json sidecar (only user_agent is), and there are no device_context_options. Not run: it would open a Facebook session. (Clear from code. It is a manual, operator-attended tool, so P3.)

- [ ] **A10-18 / P3 (raised as P2) / plausible: `rs-session check` opens a live session under a different device, and the README schedules `check --save-refreshed`**
  - Location: `trackers/facebook/rs_poster/rs_poster/session_cli.py:557-586; deploy/README.md 'Keeping sessions alive'`
  - Evidence: The check context sets only the user agent and a fixed 1440x900 viewport: no device_context_options (screen, scale, locale, timezone) and no account_lock. --save-refreshed rewrites the session file while the worker's browser holds it.
  - Failure: A routine cron check presents a second device fingerprint on the account and can revert the worker's rotated cookies, leading to session invalidation and a re-login.
  - Fix: Apply device_context_options and account_lock as session.py:195-197 does. Document `info` as the cron-safe command and `check` as an operator action.
  - Regression test: test_session_cli: check builds context kwargs identical to PosterSession's for the same sidecar.
  - Verifier: session_cli.py:557-586 opens the session with only the sidecar UA/proxy and a fixed viewport, not the worker's device profile, and with --save-refreshed writes cookies back. But deploy/README.md:218-224 schedules a weekly `rs-session info` (offline). `check --save-refreshed` appears only as a manual example, so 'the README schedules check --save-refreshed' is overstated. Fleet workers restore from coordinator snapshots, so rewriting a local configs/sessions file does not by itself revert a worker's cookies. (The second-device check is real when run by hand. The cron/revert parts of the claim do not hold as written.)

- [ ] **A10-19 / P3 (raised as P2) / confirmed: Re-capturing a session without --proxy keeps the old proxy in its sidecar**
  - Location: `trackers/facebook/rs_poster/rs_poster/cookies.py:311-318; session_cli.py:269-274,504-509`
  - Evidence: `if value: meta[key] = value` never clears a key, so a capture without a proxy leaves the previous proxy in place.
  - Failure: A session first captured through proxy X is re-captured on the house IP. PosterSession (session.py:200) and check then replay it through X, the IP-mismatch pattern master.toml says causes revocations.
  - Fix: On capture and import, write proxy explicitly, deleting it when absent.
  - Regression test: test_cookies: capture with proxy, then without; assert meta has no proxy.
  - Verifier: repro/A10-verify/a10_19_sidecar_proxy.py (a10_19.out): write_session_meta(proxy='http://proxy-x:10003') then write_session_meta(proxy=None) leaves proxy=http://proxy-x:10003 while user_agent updates. cookies.py:311-318 skips falsy values. session.py:200 and session_cli check (proxy = args.proxy or meta.get('proxy')) then replay through X. (Reproduced. It only affects rs_poster/rs-session local tools, which do not run in the live fleet (workers take proxies from the coordinator), so P3.)

- [ ] **A10-20 / P3 (raised as P2) / confirmed: rs-router reuses Matrix transaction ids after each restart, and treats transient errors as permanent; staff replies are silently dropped**
  - Location: `trackers/facebook/rs_router/rs_router/matrix.py:40,80-84; cli.py:150-157`
  - Evidence: self._txn starts at 0 in every process, so transaction ids repeat as rsrouter-1, rsrouter-2, .... Matrix dedupes PUT /send/{txnId} per access token and returns the earlier event without sending. drain_outbound acks every MatrixError, timeouts and 5xx included, with permanent=True.
  - Failure: After any router restart, the first N staff replies return 200 with an old event id and are acked 'sent', so the seller never gets them. During a homeserver restart, replies are marked permanently failed.
  - Fix: txnId = f'rsrouter-{row["id"]}' (idempotent per outbound row). Treat URLError and 5xx as retryable.
  - Regression test: test_bridge: two MatrixClient instances send different rows; assert distinct txn ids; a 503 is acked non-permanent.
  - Verifier: repro/A10-verify/a10_20_router_txn.py (a10_20.out): two MatrixClient instances (a restart) both send txn id rsrouter-1 (matrix.py:40,80-84). A refused connection raises MatrixError, which cli.py:150-157 acks as failed with permanent=True. The homeserver in deploy/docker-compose.matrix.yml is Conduit, which persists transaction ids, so a reused id returns the old event id. Live VM: no rs-router or conduit container. (Reproduced in the client. The Matrix bridge is not deployed today, so P3 until it is.)

- [ ] **A10-21 / P3 (raised as P2) / confirmed: check-secrets.sh misses the files .gitignore protects as credentials and unquoted or lowercase secret values**
  - Location: `trackers/facebook/scripts/check-secrets.sh:40-41,94-104; trackers/facebook/.gitignore:7-13,70-76`
  - Evidence: The path list lacks configs/secrets.*.env (e.g. secrets.fleetd.env), configs/account_info.txt* (passwords + 2FA), proxies.decodo.txt, data.txt and *.local.toml. The content rule needs an upper-case key with a quoted value, so RS_VAULT_KEY=abc..., "totp_secret": "...", user:pass@ proxy URLs, postgres URLs and syt_ tokens all pass. Any line containing '...' is whitelisted.
  - Failure: A force-added secrets.fleetd.env or account_info.txt passes the release gate (release.sh runs it) and lands in history.
  - Fix: Mirror the .gitignore credential block. Add an unquoted KEY=value rule, case-insensitive matching, and URL-credential and syt_ patterns.
  - Regression test: Extend scripts/tests/test-check-secrets.sh with each missed case.
  - Verifier: repro/A10-verify/a10_21_check_secrets.sh runs a copy of check-secrets.sh over fake-valued files (a10_21.out): configs/secrets.fleetd.env with an unquoted RS_HOST_TOKEN passes, configs/account_info.txt with lowercase 'password:' passes, and configs/secrets.env is refused. The path rule (check-secrets.sh:40-41) has no configs/secrets.*.env or account_info/proxies/data.txt, though .gitignore:7-13,70-76 lists them. The content rule needs quoted values (:94-95). (Reproduced. It is a backstop behind .gitignore (it needs git add -f), so P3.)

- [ ] **A10-22 / P3 / P3, not verified: Re-login (a Facebook login) records no actor and has no server-side cooldown**
  - Location: `trackers/facebook/rs_console/rs_console/app.py:271-278; rs_coordinator/routers/health.py:196-203`
  - Evidence: Only relogin_last_requested_at is stored, with no updated_by; the only confirmation is window.confirm in vnc.js:150. A press after each directive poll is another login. Mitigated by the 2/day password budget (auth.py:88-95).
  - Failure: See evidence: narrow impact as described.
  - Fix: Forward and store requested_by; 409 within N minutes of the last request.
  - Regression test: 

- [ ] **A10-23 / P3 / P3, not verified: Console path params for relogin, queue and cities are not validated; a bad id upserts a phantom worker row**
  - Location: `trackers/facebook/rs_console/rs_console/app.py:271-278,861,932-942; rs_coordinator/db.py:1390`
  - Evidence: These lack the _WORKER_ID check the session/logins routes have. The allowlist can't be escaped, but request_relogin upserts any id, which then shows in /v1/fleet.
  - Failure: See evidence: narrow impact as described.
  - Fix: Apply _WORKER_ID on all three.
  - Regression test: 

- [ ] **A10-24 / P3 / P3, not verified: Legacy fleet token can consume other workers' directives and leases; a per-worker token's mismatched path id is ignored, not refused**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/health.py:193; routers/queue.py:56,120; routers/cities.py:52`
  - Evidence: `worker or worker_id` skips the ownership check when worker is None.
  - Failure: See evidence: narrow impact as described.
  - Fix: require_own_worker semantics; retire RS_COORDINATOR_TOKEN.
  - Regression test: 

- [ ] **A10-25 / P3 / P3, not verified: Settings CLI (start-at) and the API can overwrite each other's saves**
  - Location: `trackers/facebook/rs_console/rs_console/settings.py:571-592,615-617`
  - Evidence: _settings_lock is per-process; the CLI does load, modify and save outside it.
  - Failure: See evidence: narrow impact as described.
  - Fix: fcntl.flock around load/apply/save.
  - Regression test: 

- [ ] **A10-26 / P3 / P3, not verified: vnc TicketStore is touched from threadpool and event loop without a lock**
  - Location: `trackers/facebook/rs_console/rs_console/vnc.py:99-118`
  - Evidence: _prune iterates the dict while issue() inserts from another thread; rare 'dictionary changed size' 500.
  - Failure: See evidence: narrow impact as described.
  - Fix: Lock, or make vnc_ticket async.
  - Regression test: 

- [ ] **A10-27 / P3 / P3, not verified: Non-ASCII bearer token gives 500 instead of 401**
  - Location: `trackers/facebook/rs_console/rs_console/app.py:221; rs_coordinator/deps.py:154`
  - Evidence: secrets.compare_digest(str,str) raises TypeError on non-ASCII input.
  - Failure: See evidence: narrow impact as described.
  - Fix: Compare .encode() bytes.
  - Regression test: 

- [ ] **A10-28 / P3 / P3, not verified: Public /vnc/{worker_id} reveals which worker ids exist**
  - Location: `trackers/facebook/rs_console/rs_console/app.py:515-521`
  - Evidence: Answers 404 or 200 without a token, and triggers the A10-12 coordinator fetch.
  - Failure: See evidence: narrow impact as described.
  - Fix: Always serve the shell.
  - Regression test: 

- [ ] **A10-29 / P3 / P3, not verified: /v1/fleet drops queue/city_tiers keys instead of returning null when the coordinator is down**
  - Location: `trackers/facebook/rs_console/rs_console/app.py:748-759`
  - Evidence: apply_queue/apply_tiers run only when rows is not None, which contradicts AGENTS.md ('Both are null').
  - Failure: See evidence: narrow impact as described.
  - Fix: apply_queue(doc, None) in the else branch.
  - Regression test: 

- [ ] **A10-30 / P3 / P3, not verified: Ops pages from request handlers are sent inline and dropped during a Telegram outage**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/health.py:131-137; routers/escalation.py:116-121; routers/logins.py:64`
  - Evidence: Direct ops_notifier.send (30 s timeout, shared pacing lock) rather than the outbox.
  - Failure: See evidence: narrow impact as described.
  - Fix: db.enqueue_alert as the incidents path does.
  - Regression test: 

- [ ] **A10-31 / P3 / P3, not verified: A deleted Telegram forum topic is never recreated**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/telegram_topics.py:97-99; background.py:127-130`
  - Evidence: ensure_topic trusts the stored id; sends retry with it forever.
  - Failure: See evidence: narrow impact as described.
  - Fix: On 'thread not found', clear and recreate.
  - Regression test: 

- [ ] **A10-32 / P3 / P3, not verified: Any worker token reads every worker's raw row**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/health.py:218-225`
  - Evidence: /api/v1/workers returns list_workers() raw (account_id, vnc_url, host_id).
  - Failure: See evidence: narrow impact as described.
  - Fix: Legacy token only, or trim fields.
  - Regression test: 

- [ ] **A10-33 / P3 / P3, not verified: Wrong or rotated vault key shows every secret as unset**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/accounts.py:38-44; vault.py:189-195`
  - Evidence: VaultError becomes {}, so presence flags read false; there is no MultiFernet or rekey command.
  - Failure: See evidence: narrow impact as described.
  - Fix: Return vault_unreadable; MultiFernet + `rsc vault rekey`.
  - Regression test: 

- [ ] **A10-34 / P3 / P3, not verified: Auto-reply check-then-stamp is not atomic; two syncs can queue two replies**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/routers/messages.py:113-124`
  - Evidence: decide() reads autoreplied_at, and the stamp is written after enqueue_outbound.
  - Failure: See evidence: narrow impact as described.
  - Fix: Conditional UPDATE ... WHERE autoreplied_at IS NULL; queue only on rowcount 1.
  - Regression test: 

- [ ] **A10-35 / P3 / P3, not verified: Email-code freshness check has no clock-skew slack**
  - Location: `trackers/facebook/rs_coordinator/rs_coordinator/email_codes.py:280-295`
  - Evidence: `sent >= cutoff` compares Facebook's Date header with the worker-supplied since; a code dated a second early is rejected.
  - Failure: See evidence: narrow impact as described.
  - Fix: Allow about 120 s of slack.
  - Regression test: 

- [ ] **A10-36 / P3 / P3, not verified: Multi-line staff reply is typed as several Enter-sent messages, then marked failed**
  - Location: `trackers/facebook/rs_messenger/rs_messenger/sender.py:77-79,228-230`
  - Evidence: Playwright types \n as Enter; the visibility probe joins whitespace, so ERR_NOT_VISIBLE is permanent.
  - Failure: See evidence: narrow impact as described.
  - Fix: Shift+Enter between lines, or flatten.
  - Regression test: 

- [ ] **A10-37 / P3 / P3, not verified: make-region-config.py swaps the proxy server but keeps the homelab proxy's credentials**
  - Location: `trackers/facebook/deploy/make-region-config.py:82-86; configs/master.toml:40-41`
  - Evidence: Only proxy_server is replaced; PROXY_HOMELAB_NE_USER/PASS have no reader.
  - Failure: See evidence: narrow impact as described.
  - Fix: Rewrite USER/PASS refs too and assert it.
  - Regression test: 

- [ ] **A10-38 / P3 / P3, not verified: Coordinator LAN override and the live haproxy relay both bind 10.10.10.73:8500; the LAN/registry docs rely on ufw, which Docker-published ports bypass**
  - Location: `trackers/facebook/deploy/docker-compose.coordinator-lan.yml:17-18; docker-compose.coordinator-relay.yml:7-8; docker-compose.registry.yml:7; scripts/deploy.sh:368-371`
  - Evidence: Live: rs-coordinator-lan is the haproxy relay on 10.10.10.73:8500. configs/secrets.coordinator-lan.env is absent, so deploy.sh takes the plain path today. Creating that file (per the registry docs) makes the next coordinator recreate fail on 'port already allocated'.
  - Failure: See evidence: narrow impact as described.
  - Fix: Delete coordinator-lan.yml or make deploy.sh skip it when the relay exists; document the relay; DOCKER-USER rules or haproxy ACLs for any LAN port; htpasswd on the registry.
  - Regression test: 

- [ ] **A10-39 / P3 / P3, not verified: Floating image tags on services holding a Facebook session; messenger built FROM aimm-recycle:latest**
  - Location: `trackers/facebook/deploy/docker-compose.matrix.yml; docker-compose.console.yml; Dockerfile.messenger`
  - Evidence: cloudflared:latest, matrix-conduit:latest and mautrix/meta:latest; releases now tag ghcr.io/jinhuw/aimm-recycle:<VERSION>, so the messenger's base is stale.
  - Failure: See evidence: narrow impact as described.
  - Fix: Pin by version or digest.
  - Regression test: 

- [ ] **A10-40 / P3 / P3, not verified: Terraform for the coordinator Postgres keeps local state and protects only the service**
  - Location: `trackers/facebook/infra/terraform/main.tf; postgres.tf`
  - Evidence: State (the only copy of the generated password and mapping) is local and lost with a worktree. prevent_destroy is on railway_service.postgres but not railway_project. The DB has no snapshots and a public TCP proxy.
  - Failure: See evidence: narrow impact as described.
  - Fix: Remote backend; prevent_destroy on the project; scheduled pg_dump to R2.
  - Regression test: 

- [ ] **A10-41 / P3 / P3, not verified: rs-poster post can duplicate an ad@city; the ledger upsert orphans the first listing**
  - Location: `trackers/facebook/rs_poster/rs_poster/poster.py:180-238`
  - Evidence: Only max_active_ads is checked.
  - Failure: See evidence: narrow impact as described.
  - Fix: Refuse if an active ledger row exists for ad@city.
  - Regression test: 

- [ ] **A10-42 / P3 / P3, not verified: build-monitor-image.sh stamps the ERP repo's commit as RS_MONITOR_COMMIT, and its dirty check can never fire**
  - Location: `trackers/facebook/scripts/build-monitor-image.sh:21-26`
  - Evidence: `git -C $ROOT rev-parse` is the monorepo HEAD, and ai-marketplace-monitor is gitignored there, so status is always clean. deploy.sh:339 and push-fleet-images.sh:79 use the clone's own HEAD.
  - Failure: See evidence: narrow impact as described.
  - Fix: git -C $ROOT/ai-marketplace-monitor rev-parse / status.
  - Regression test: 

- [ ] **A10-43 / P3 / P3, not verified: release.sh doesn't run rs_router's tests or bump its version; rs_fleetd is now dormant on the VM**
  - Location: `trackers/facebook/scripts/release.sh:153-162,172-195; rs_router/pyproject.toml (version 0.1.0)`
  - Evidence: rs_router is deployed (matrix compose) but is outside the gate and the version sweep. The VM runs no rs-fleetd (the TS fleet-agent replaced it), yet deploy.sh, AGENTS.md and `rsc fleet release` still treat it as the rollout path.
  - Failure: See evidence: narrow impact as described.
  - Fix: Add rs_router to run_suite and the bump list; mark rs_fleetd legacy or remove it.
  - Regression test: 

- [ ] **A10-44 / P3 / P3, not verified: VM keeps seven secrets.env.bak-* copies, including ones from before the 2026-10-22 rotation**
  - Location: `10.10.10.73:recycle_servers/facebook_tracker/configs/ (names only)`
  - Evidence: secrets.env.bak-20261004 through -20261023-rs375 (pre- and post-rotation). The rsync filter protects /configs/secrets.env.*, so they persist indefinitely.
  - Failure: See evidence: narrow impact as described.
  - Fix: Owner to delete the obsolete backups after confirming the rotation.
  - Regression test: 

## Reported here, tracked elsewhere

- A10-14: The documented ERP contract omits the two session routes the ERP uses, and rs_console's safety docstring overstates its blast radius → tracked as **C2-02**
- A10-16: A legacy Mac monitor and a daily headless session probe still run from the archived checkout, outside the fleet and its device and proxy rules → tracked as **B5-01**

## Limits

- **A10**: Test results (per-package venvs <pkg>/.venv-review, python3.12, not committed; AIMM_PYTHON pointed at the main checkout's .venv-aimm whose clone is at the VENDOR.md pin 3576db7b): rs_coordinator 594 passed, 31 skipped (2 need AIMM_PYTHON in-process, 29 test_postgres need RS_TEST_DATABASE_URL; no Postgres run). rs_poster 96 passed. rs_messenger 37 passed. rs_console 134 passed. rs_fleetd 61 passed. rs_router 8 passed. rs_worker 67 passed (run with the aimm venv). scripts/tests pytest 37 passed. Shell gates test-version-gate, test-check-secrets, test-deploy-filter all passed. Repro: docs/review-2026-10-31/repro/A10/test_seed_overwritten_by_stale_backup.py passes (run from trackers/facebook/rs_coordinator with .venv-review), confirming A10-04. Never ran deploy.sh, release.sh (not even --dry-run), any worker restart, relogin or rsc fleet release, and never read configs/sessions/ or any secrets file contents. Coverage: rs_console, rs_coordinator, poster/messenger/router and deploy/infra/configs were reviewed with the help of three read-only sub-reviewers. The lane owner verified every P1/P2 against the code (A10-16 against launchd too) except A10-15 and A10-17 to A10-21, which carry the sub-reviewer's file:line evidence. Vendored static/novnc/*, fonts and architecture.drawio were listed but only skimmed. city_log.py, city_tiers.py, sharding.py, cookies.py (coordinator) and device_profiles.py were read lightly. CHANGELOG.md and README.md were read by section, not end to end. The vendored ai-marketplace-monitor (the actual login code) is outside this lane's file list. Its boot/relogin behaviour is the largest unreviewed login surface.
