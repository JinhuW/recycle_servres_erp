# WS-F · Ops: images, Railway env, host prep, integration, cutover

**Depends on:** CI and host prep now; integration after A+B+C; cutover after
D+E. **Owns:** `.github/workflows/fleet-images.yml`, Railway env for
`backend` (dev then prod), `HOSTS.md`, the cutover runbook below, the
follow-up ticket that retires the coordinator's queue.

Every step on a live host or on prod needs the owner's explicit yes, one step
at a time. Each worker container start is a Facebook login (root `AGENTS.md`,
first rule).

## Now (parallel with A–E)

1. **GHCR workflow** `fleet-images.yml`: on a `facebook-tracker/v*` tag build
   and push `ghcr.io/jinhuw/aimm-recycle:<ver>` from
   `trackers/facebook/deploy/Dockerfile.worker` (the vendored monitor is
   gitignored: the workflow clones `recycle-patches` from a private mirror
   the owner creates, pinned to `VENDOR.md`; until that mirror exists, build
   the image on the Mac and push by hand); on a root `v*` tag build
   `ghcr.io/jinhuw/fleet-agent:<ver>` from `apps/fleet-agent/Dockerfile`.
   Make both packages private; add a read token to the hosts' docker login.
   - [x] `.github/workflows/fleet-images.yml` on dev (2026-10-24). Both jobs
         skip with a `::notice` until their inputs exist, so the workflow is
         green before WS-C and WS-D land. What the owner sets: repository
         variable `AIMM_MIRROR_REPO` (`owner/repo` of the private mirror) and
         secret `AIMM_MIRROR_TOKEN` (fine-grained PAT, *Contents: read* on
         that repo only) for the worker job; variable
         `GHCR_PRIVATE_CONFIRMED=yes` for both jobs, after creating the two
         packages private by hand (steps in the workflow header). The pin is
         parsed from `VENDOR.md` at run time with the same `awk` as
         `scripts/check-vendor.sh`, the clone token travels in a per-command
         header so it never lands in the build context, and each job refuses
         to push to a package that anonymous pulls can read.
   - [x] Root `v*` tags are created by `version-check.yml` with
         `GITHUB_TOKEN`, and GitHub starts no workflow from such an event, so
         the agent job also runs on pushes to `dev` touching
         `apps/fleet-agent/**` or the root manifests and reads the version
         from `package.json`; it skips when that version is already tagged on
         another commit (a forgotten bump).
   - [x] `.github/` is not on `version-check.yml`'s code path list, so the
         workflow alone needed no root version bump.
   - [ ] First real build of each image (needs the mirror, the private
         packages, WS-C's Dockerfile, WS-D's Dockerfile).
   - **Images are pushed from the Mac** with
     `trackers/facebook/scripts/push-fleet-images.sh` to private GHCR
     packages `ghcr.io/jinhuw/{aimm-recycle,fleet-agent}` (owner, 2026-10-25:
     GHCR while it works, nothing to OCI; `HOSTS.md` → *Registry*).
     `fleet-images.yml` stays, inert, with a header note.
   - [x] Two private OCIR repositories created 2026-10-24; left empty as the fallback.
   - [x] Push script dry run (`--no-push`) built both images for amd64.
   - [x] First real pushes (2026-10-26 UTC): `aimm-recycle:0.14.0`, `0.14.1`,
         `fleet-agent:1.348.0`, `1.349.0`; private, anonymous pull refused.
   - [x] `docker login ghcr.io` on the Mac (`gh` token) and on `worker-60-14`
         (the Reddit fleet's `read:packages` PAT).
2. **Railway env (dev first):** `FLEET_WORKER_TOKEN_KEY`, `FLEET_IMAGE_WORKER`,
   `FLEET_IMAGE_AGENT`, `FLEET_COORDINATOR_URL` on the `backend` service.
   Prod gets the same at cutover.
   - [x] Set on 2026-10-24 on project `recycle-erp-experiment`, environment
         `dev` (`b20fb714…`, confirmed as `dev` through `railway status` and
         the Railway API before writing), service `backend`
         (`api.dev.recycleservers.com`), with `railway variables --set`, so
         the generated key never passed through a transcript or a file.
         Values other than the key: `FLEET_IMAGE_WORKER=ghcr.io/jinhuw/aimm-recycle:0.14.0`
         (the next tracker minor), `FLEET_IMAGE_AGENT=ghcr.io/jinhuw/fleet-agent:1.340.0`
         (a placeholder; WS-D's real root version replaces it),
         `FLEET_COORDINATOR_URL=http://10.10.10.73:8500` (the VM's LAN
         address; the coordinator is **not** published there yet, see
         `HOSTS.md`). The set redeployed the dev backend; production was not
         touched.
3. **Host prep `worker-60-14`** per `HOSTS.md` checklist, read-only until the
   owner says go.
   - [x] `HOSTS.md` carries the owner-runnable, read-only block with expected
         answers, the GHCR login step, the agent one-liner and what to paste
         back. No command was run on the host; it answered `ping` and
         `tcp/22` from the Mac at about 20:40 UTC on 2026-10-24 after being
         unreachable earlier that day (`HOSTS.md` → *Reachability*).
   - [x] The block ran on 2026-10-24; output under *Timings and
         surprises* below.
4. **Export files for WS-B's slot seed** (one-time, by hand on the VM, never
   committed): home cities per account from `rs_console` `/v1/fleet`, device
   profiles from the coordinator's `device_profiles` (`rsc` + vault key), the
   proxy login from `configs/secrets.env`. Hand them to the WS-B seed script
   on dev with throwaway values first.
   - [x] Procedure written below (*Export procedure for the slot seed*). Not
         run: it touches secrets on the live VM and the seed script does not
         exist yet. WS-B tests with made-up values.

### Export procedure for the slot seed (run by hand, on the VM, at seed time)

Everything here runs on `jinhu@10.10.10.73` in
`~/recycle_servers/facebook_tracker`, writes to `/tmp` on the VM, and is
handed to `apps/backend/scripts/fleet-seed-slots.mjs` over an `scp` into a
scratch directory on the operator's machine that is deleted afterwards. Since
v1.356.0 the seed (and `fleet-import.mjs`) writes to a non-local
`DATABASE_URL` only with `FLEET_SEED_REMOTE=true` (`FLEET_IMPORT_REMOTE=true`),
and the import adds only what the ERP lacks unless `--overwrite`. None
of these files is ever committed; `home-cities.json` and `devices.json` carry
no secret, the proxy login does and stays in the operator's shell.

**1. Home cities per worker** (`home-cities.json`). The console's `/v1/fleet`
document has each worker's cities (`workers[].cities[].slug`). The console
container has no `curl`; read it with Python and the console token from
`configs/secrets.env`:

```bash
set -a; . configs/secrets.env; set +a
docker exec -e T="$RS_CONSOLE_TOKEN" rs-console python3 - <<'PY' > /tmp/home-cities.json
import json, os, urllib.request
req = urllib.request.Request("http://127.0.0.1:8600/v1/fleet", headers={"Authorization": "Bearer " + os.environ["T"]})
doc = json.load(urllib.request.urlopen(req, timeout=60))
print(json.dumps({w["worker_id"]: [c["slug"] for c in (w.get("cities") or [])] for w in doc["workers"]}, indent=1))
PY
```

Shape WS-B's seed reads: `{ "<worker_id>": ["<slug>", …], … }`, keyed by the
coordinator's worker id (`nyc-1`, `homelab-1`, …). The seed joins it to an
account through the ERP's open stint, `fb_worker_accounts.worker_id` →
`account_no` (`ended_at IS NULL`), which is the same id the ERP's *Assign to
fleet* wrote. A worker with no open stint has no slot to seed; the seed
reports it and moves on.

**2. Device profiles** (`devices.json`). One row per Facebook account in the
coordinator's `device_profiles`, keyed by `fb_uid` (= `fb_pool_accounts.uid`).
`rsc identity list` prints them for people; the JSON comes from the table.
The encrypted `device_cookies_blob` (`datr`/`sb`) is left out: those cookies
are already inside the session the ERP holds in `cookie_enc`, and the claim
answer's `device` carries only what the browser is told to present.

```bash
docker exec rs-coordinator python3 - <<'PY' > /tmp/devices.json
import json
from rs_coordinator.deps import open_database   # the coordinator's own connection
rows = open_database().list_device_profiles()
out = {}
for p in rows:
    if not p.get("fb_uid"):
        continue                                 # a profile with no uid cannot be matched to a pool account
    out[p["fb_uid"]] = {
        "user_agent": p.get("user_agent"),
        "viewport": [p["viewport_w"], p["viewport_h"]],
        "screen": [p["screen_w"], p["screen_h"]],
        "device_scale_factor": p["device_scale_factor"],
        "locale": p["locale"],
        "timezone": p["timezone_id"],
    }
print(json.dumps(out, indent=1))
PY
```

Shape: `{ "<fb_uid>": { "user_agent", "viewport": [w, h], "screen": [w, h],
"device_scale_factor", "locale", "timezone" }, … }`. The seed stores it as
`fleet_slots.device`; the claim answer (`CONTRACTS.md` §5) sends
`user_agent`, `viewport`, `timezone`, `locale` from it. If
`open_database`/`list_device_profiles` moved, `rsc identity list` names the
module (`rs_coordinator/cli.py`, `cmd_identity_list`).

**3. Proxy login.** Every worker's proxy URL without its login is already in
the ERP: `fb_worker_accounts.proxy_url` (`scheme://host:port`, stamped by
`/assign`). The login is the Decodo pair in `configs/secrets.env`
(`PROXY_HOMELAB_<X>_USER` / `_PASS`, one pair per exit, same user for all
Decodo exits today). The seed takes it as `FLEET_SEED_PROXY_USER` /
`FLEET_SEED_PROXY_PASS` environment variables, writes
`scheme://user:pass@host:port` sealed with `FB_POOL_KEY` into
`fleet_slots.proxy_url`, and never prints it. Read the values on the VM
(`grep '^PROXY_HOMELAB_NYC_' configs/secrets.env`) and type them into the
operator's shell for that one command; do not scp `secrets.env`.

**4. Run order.** `--dry-run` first against dev with the two JSON files, then
for real; against prod only at cutover step 0 (`memory: fb-pool-prod-import`
for the credentials path). Delete the scratch copies afterwards.

### Timings and surprises (filled during Integration)

- 2026-10-24: `10.10.60.14` unreachable from the Mac in the morning,
  reachable (ping, tcp/22) at about 20:40 UTC; not logged in. The homelab VM
  reaches it too.
- 2026-10-24: the live workers carry `RS_COORDINATOR_URL=http://coordinator.tailnet:8500`
  (the example value; no tailnet interface on the VM) and
  `RS_CONTROL_PLANE_URL=http://rs-coordinator:8500`. Only the second
  resolves, over the `rs-fleet` network. The coordinator is published on
  `127.0.0.1:8500` only; `configs/secrets.coordinator-lan.env` does not exist
  on the VM, so the LAN publish is off.
- Host checklist output (`worker-60-14`, 2026-10-24, read-only; the ERP
  check ran against the Cloudflare hostnames and the registry check against
  `ghcr.io` and `iad.ocir.io`): Ubuntu 24.04.5, `x86_64`, 8 CPUs, 62 GB RAM,
  94 GB free on `/`; Docker 29.9.2, cgroup v2; user `worker` in group
  `docker`; no containers; `inventory-dev.recycleservers.com` and
  `api.dev.recycleservers.com` answer 200; `ghcr.io` and `iad.ocir.io` answer
  401 (reachable, anonymous refused); `10.10.10.73:8500` closed; clock
  synchronized, UTC. Every line is within the expected answers; capacity is
  not the constraint for the 4-worker pilot.
- 2026-10-24: `https://api.recycleservers.com` is **not** the ERP (Cloudflare
  522); the plan's example `FLEET_URL` was wrong. Hosts use the Cloudflare
  hostnames `inventory-dev.recycleservers.com` / `inventory.recycleservers.com`
  (`HOSTS.md`).
- 2026-10-24, registry: images moved from GHCR to OCIR (owner's decision).
  The Always-Free Toronto tenancy (`jinhuwang112`) refuses OCIR
  (`403 FREE_TIER_NOT_SUPPORTED`), so the repositories live in the
  Pay-As-You-Go Singapore tenancy, `sin.ocir.io/ax6usa8hwbie/{aimm-recycle,fleet-agent}`,
  private (an anonymous token pull answers `DENIED`). That tenancy's user
  already holds the maximum two auth tokens (both described
  `terraform-backend`, created seconds apart in 2025-05), so no token was
  created and no `docker login` ran on the Mac or the host: one token must be
  freed or a separate pull user created by the owner (`HOSTS.md` → *Registry*).
  OCIR has no retention policy in the API; cleanup to the newest 3 tags is
  manual.
- 2026-10-24: `push-fleet-images.sh --no-push` built both images for
  `linux/amd64` on the Mac (builder `multiarch`, Colima) in 5 min 49 s from
  cold: worker `aimm-recycle:0.13.18` from a monitor clone at the pin
  `9a06d98` (context 1.3 MB through `Dockerfile.worker.dockerignore`), agent
  `fleet-agent:1.343.0`. It refused a dirty monitor clone, a clone off the
  pin, and a push of an unreleased tracker tree.

#### MVP run: the first real fleet worker (2026-10-26 UTC, `worker-60-14`, dev ERP)

The owner approved one login on `worker-60-14` with a retired pool account,
no coordinator, images on GHCR, the shared secrets from Cloudflare, and an
unused proxy port.

| Step | When (UTC) | Outcome |
| --- | --- | --- |
| Dev catalog: `fleet-import.mjs` (127 cities, 2 items), then all but `nyc`, `philly`, `boston` disabled | 02:06 | 6 ready tasks |
| Retired account #37 copied from prod's pool, resealed under dev's `FB_POOL_KEY`; the only `fleet_slots` row; New York device profile; home cities the three | 02:08 | not in the coordinator's vault (checked by uid); no prior stints |
| Proxy: Decodo static ISP port `10018` (NJ1) | 02:09 | ports above 10020 wrap onto the 20 IPs (10021 = 10001's IP), so no IP is free; NJ1's two homelab workers (`nj-1`, `nj-1b`) are both `SESSION_EXPIRED`, so nothing live searches through it. Re-logging either of them puts it on the same IP as #37 |
| Host registered (SQL, token hash only), env file, agent 1.348.0 observe-only | 02:09 | ticks reported, `last_seen_at` moving |
| capacity 1, first worker start | 02:10 | **claim 403 ×3, exit 70, no login**: Cloudflare's Browser Integrity Check (error 1010) refuses urllib's default `Python-urllib` agent. Capacity set back to 0. Fixed in facebook-tracker 0.14.1 (#903): the worker names itself `rs-worker` |
| Agent replaced by 1.349.0 (RS-400 confirmed-stop handoff) | 02:24 | the agent container runs no account |
| capacity 1, second start | 02:25 | claim through Cloudflare (`epoch` 1), **one login**, HEALTHY; first task leased in 0.1 s |
| Task 2 `boston/enterprise_ssd` | 02:25 → 02:51 | `{cards 120, opened 84, reviewed 73, alerted 0, seconds 1535}` |
| Task 1 `boston/server_ram` | 02:51 → 03:10 | `{cards 120, opened 60, reviewed 56, alerted 0, seconds 1158}` |
| Scheduler | 02:51, 03:10 | next day's cadence tasks written for both pairs |
| `nyc/enterprise_ssd` leased | 03:10 | worker HEALTHY, `fleet_minutes` 49.8 for #37 |

**Logins used: 1.** The stale-epoch / agent-restart check was skipped (it
costs a second login).

Surprises:
- **A city-item takes 19–26 minutes, not 4–7.** Without the coordinator
  there is no listing dedupe, so every card worth a look is opened (60–84 per
  search). At this rate the 360-minute budget covers ~15 city-items per
  account per day, and the 254-pair catalog would need ~17 accounts. Wiring
  the coordinator back (dedupe) is the first lever.
- **The running worker is the stale 0.14.1 build** (`a9a4f6f`, without
  RS-400's worker changes). `aimm-recycle:0.14.1` was pushed twice, and the
  host's cached first push won because the agent pulls only a missing image.
  The host now caches the right build; replacing the worker would cost a
  login. Rule: never re-push a tag (`HOSTS.md` → *Registry*).
- No alerts go anywhere: `FLEET_WORKER_ENV` carries only `OPENROUTER_API_KEY`
  (the Facebook tracker has no dev Telegram channel, and without the
  coordinator's dedupe a second alert stream would duplicate the buyers'
  chat). `alerted` counts what would have been sent.
- The run left the worker HEALTHY and searching at capacity 1 on the dev ERP.
- **Restart check: a fenced worker kept searching.** The slot's epoch was
  bumped at 03:36:05; the heartbeat logged the 409 at 03:36:18 and the relay
  stopped dialing, but the worker searched `philly/server_ram` for 17 more
  minutes and exited 75 only at 03:53:19. Capacity was 0 within 6 s, so the
  agent's restart never ran; #37 used two logins in total. Fixed in
  facebook-tracker 0.14.3 (monitor `f0da469`): any refused fleet call stops
  the search before its next page.

#### Coordinator wiring for fleet workers (2026-10-26 UTC, dev)

Owner's decisions the same day: wire the coordinator in; **no Telegram or
buyer-visible alert from a fleet worker until the fleet ships to prod**; no
running container on the VM stopped, restarted, recreated or edited; no
fleet worker started and no Facebook login for this.

| Step | Outcome |
| --- | --- |
| Where alerts come from today | The **worker** sends Telegram itself (`[user.recycle]` `telegram_*`, `User.notify` in `monitor.py`), after claiming the listing from the coordinator (`POST /v1/alerts/claim`, then `/claim/delivered`); `alert_report_url` then reports the Telegram message id to the coordinator (`/v1/alerts/telegram`, hit-rate stats). The **coordinator** sends Telegram on a worker's behalf for: listings posted to the legacy `/api/v1/listings` (no fleet config uses it), heartbeat state changes, challenges (`/v1/auth/escalate`), incidents (`/v1/incidents`), and a login on a foreign `datr` or a lock page (`/v1/workers/{id}/logins`, only for a worker the vault maps to an account) |
| Why "no alerts" also means "no claims, no city reports" | A claim the fleet worker never delivers holds the listing from the live workers for `CLAIM_LEASE` (15 min); a reported search (`/v1/stats/reviews` with a city) is a *visit* in the live city queue (`city_queue.live_state`), so the live fleet would skip a city the fleet searched without alerting |
| The switch (facebook-tracker 0.14.2, monitor `88a505d`) | `RS_ALERTS=on` in the claim's `env` turns alerts on; absent = off. Off: no Telegram or alert-report key rendered, `[fleet] alerts = false` (the monitor skips claim and send, logs `[Alert] WITHHELD`, reports no city, funnel count, wall or incident to the coordinator), `RS_CONTROL_PLANE_URL` unset. Tests: entrypoint (render, token map, exit 70 for an unmapped id) and the monitor's fleet loop against the fake fleet with a coordinator configured: one listing rated 5, judged, not sent, nothing but `/api/fleet/worker/*` spoken to |
| Route | `rs-coordinator-lan` (socat) on the VM: `10.10.10.73:8500` → `rs-coordinator:8500`, admits only `10.10.60.14` (`HOSTS.md` → *Coordinator route*). No firewall rule changed |
| Auth | per-worker tokens (`rsc mint-token`, stateless) for `worker-60-14-1` … `-8` in `FLEET_WORKER_ENV` as `RS_CONTROL_PLANE_TOKENS` (`CONTRACTS.md` §2). Verified from `10.10.60.14` with curl only |
| `FLEET_WORKER_ENV` (dev) | `OPENROUTER_API_KEY` (same key as before, fingerprint-checked against the VM's) and `RS_CONTROL_PLANE_TOKENS`. Left out on purpose: `RS_ALERTS`, `TELEGRAM_*`, `RS_ALERT_REPORT_URL`, `RS_COORDINATOR_TOKEN` (the fleet-wide legacy token) |
| Railway dev `backend` | `FLEET_COORDINATOR_URL=http://10.10.10.73:8500`, `FLEET_IMAGE_WORKER=ghcr.io/jinhuw/aimm-recycle:0.14.2`, set together |

What it does **not** buy: speed. The 19–26 min per city-item in the MVP run
come from opening every card the worker has not cached itself
(`get_listing_details` → `Listing.from_cache`, the container's
`~/.ai-marketplace-monitor`, gone when the container is replaced). The
coordinator dedupes *alerts* after a listing is opened and judged; it has no
"seen listing" check a worker could ask before opening. A worker that keeps
its container sees the second day's cards from its cache; the levers are
keeping that cache across containers (a volume per slot) or a shared seen-list
in the ERP.

The worker running on `worker-60-14` keeps `0.14.1` and its claim (no
coordinator) until it is replaced; the next container the agent starts runs
`0.14.2` with the coordinator. A `0.14.1` container started against this
config would exit `70` before the browser (it does not read the token map,
and RS-400 refuses a configured coordinator without a token).

To turn alerts on after prod: put `FLEET_WORKER_ENV` again with `RS_ALERTS=on`,
`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_HIGH|MEDIUM|LOW` and
`RS_ALERT_REPORT_URL` (the coordinator URL) beside the two keys above, and
give prod's `FLEET_COORDINATOR_URL` a route the prod hosts can reach.

#### Coordinator and console on 0.14.4 (2026-10-26 UTC, homelab VM)

Owner's yes to recreate `rs-coordinator` and `rs-console` only, for 0.14.4's
`/v1/fleet` and `/v1/accounts` speed-ups. Done by hand, not `deploy.sh`
(which recreates every worker).

| Step | Outcome |
| --- | --- |
| Where they come from | compose project `deploy`, `deploy/docker-compose.coordinator.yml` and `deploy/docker-compose.console.yml` under `~/recycle_servers/facebook_tracker` (the LAN override is not applied; `rs-coordinator-lan` is a standalone socat). Both compose files and both Dockerfiles were already identical to the tag |
| Backup | `~/recycle_servers/backups/coord-console-0.13.18-20261026T101205Z/code.tgz` (both code dirs, Dockerfiles, compose files); images tagged `rs-coordinator:rollback-0.13.18` and `rs-console:rollback-0.13.18` |
| Sync | `rsync --checksum` of `rs_coordinator/` and `rs_console/` from the `facebook-tracker/v0.14.4` tree: the 14 files of the 0.13.18 → 0.14.4 diff, nothing deleted, no config or secret. No coordinator schema change in the range |
| Build, then recreate | `docker compose -p deploy -f <file> build <svc>`, then `up -d --no-deps --no-build <svc>` (dry run first): coordinator 10:12:50, console 10:13:02. Both healthy, coordinator `/healthz` `0.14.4`, no error lines in their logs |
| `/v1/fleet` (console, in-container) | before 3.73–4.37 s (3 calls); after 1.58–1.81 s (4 calls); same 156 KB document |
| `/v1/accounts` (coordinator) | before 1.79 s; after 0.10–0.11 s |
| Workers | all 15 HEALTHY workers heartbeated again after 10:12:50 (by 10:17:45); every `rs-monitor-*` container (41) kept its container id and `StartedAt`; only the two recreated containers differ in `docker ps -a` |
| LAN route | `worker-60-14` → `http://10.10.10.73:8500/healthz` 200 through `rs-coordinator-lan` |

`.rs-deployed` still reads `0.13.18`: the workers run 0.13.x, so the stamp
for a whole-tree deploy stays as it was. Rollback is `docker tag
rs-coordinator:rollback-0.13.18 rs-coordinator:latest` (same for the
console), then the same `up -d --no-deps --no-build` per service.

The vendored monitor's `recycle-patches` was pushed to the private mirror
`JinhuW/aimm-recycle-patches` the same day, fast-forward `8d9dde5` →
`1efd1a4` (the `VENDOR.md` pin).

#### Pilot on dev: four live accounts (2026-10-26 UTC, `worker-60-14`)

The owner approved the pilot with four parked live accounts on the dev ERP:
nj-1 (pool #24, Decodo `:10018`), bos-1 (#27, `:10011`), ca-3 (#22,
`:10016`) and nyc-3b (#34, `:10013`). Alerts stayed off (no `RS_ALERTS`, no
Telegram).

| Step | When (UTC) | Outcome |
| --- | --- | --- |
| Nightly db-sync keeps the dev fleet (#923, v1.359.0) | 10:21 merged, 10:23 db-sync deployed | the 04:03 copy had emptied every `fleet_*` table and pool `*_enc`; from the 2026-10-27 04:00 run the fleet tables and the slotted accounts' sealed columns survive the copy (`deploy/railway-sync/keep-fleet.sql`, `restore-fleet.sql`) |
| Host re-registered (token hash computed on the host), `fleet-import.mjs` on dev, only `nyc`, `philly`, `boston`, `reno`, `108398645850982` enabled | 10:22–10:24 | 10 ready tasks |
| Agent replaced by 1.352.0 (`--stop-timeout 120`, log rotation) | 10:24 | ticks, `last_seen_at` moving. The owner tried the Hosts tab's capacity stepper meanwhile (capacity 5): one worker started at 10:25, claim 409 (no slot existed), removed at capacity 0; no login |
| Re-check on the VM | 10:29 | all four parked (nj-1, bos-1, ca-3 `SESSION_EXPIRED`, nyc-3b `CHECKPOINT`), none `LOCKED` in the vault; their proxy partners nj-1b, bos-1b, ca-3b, nyc-3 all parked; no other proxy shares the four ports or IPs |
| `rsc queue` | 10:31:20 | the queue enrolled `*`, and `unenroll` of single workers is refused then; ran `unenroll --all` and `enroll` of the 38 others in one command. The queue is now an explicit list: a new worker is not enrolled by itself |
| `docker stop -t 30` (state and `RS_WORKER_ID` re-checked right before each) | 10:31:32 `rs-monitor-nj1`, :34 `rs-monitor-bos`, :35 `rs-monitor-ca3`, :36 `rs-monitor-nyc3b` | each exit 0; nothing else on the VM touched |
| Pool rows copied from prod (uid checked), resealed under dev's key, `fleet`/`fleet pilot`; 4 slots with their own sealed Decodo endpoint (the VM's one shared login, piped), device from the coordinator's profiles, home cities from `/v1/fleet` (nj-1, nyc-3b Newark; bos-1 boston; ca-3 reno) | 10:32 | verified: every sealed value opens, `fleet` held through the alive check |
| `authoritative=true`, capacity 4, one update | 10:34:00 | |
| `worker-60-14-1` started, claimed **#22 (ca-3)** | 10:34:06 | ledger: one `boot` (`device pool-22`, session opened) at 10:34:14 |
| Lock page | 10:34:49 heartbeat | `CHECKPOINT`, `wall: locked` (Facebook's lock page, `/checkpoint/828281030927956/`), `browser_ok` |
| Guard: slot #22 parked, capacity 0 | 10:34:51 | no further start; the agent removed the worker at 10:35:07 (`beyond count 0`) |

**Logins used: 1** (ca-3). No task was leased; no search ran. nj-1, bos-1
and nyc-3b were never started: their slots wait unclaimed, and their homelab
containers stay stopped. Final state: `worker-60-14` `authoritative=false`,
capacity 0; slot #22 parked (epoch 2); no fleet worker running.

What it tells us:
- ca-3's prod cookie opened a session and went straight to the lock page.
  ca-3 was `SESSION_EXPIRED` on the homelab; whatever parked it was not
  cleared by the fleet's claim (same proxy exit, the pool's cookie, the
  ledger's `device pool-22`). The lock is
  recorded in the ERP only (the coordinator marks `LOCKED` only for worker ids
  its vault maps, and `worker-60-14-1` is not one).
- The next attempt needs accounts that are healthy, or freshly re-logged by a
  person, not parked ones; and an owner's decision on whether to try the three
  untried slots at all.
- The guard (log every 30 s; park on `CHECKPOINT`/`CHALLENGE`/`DEAD`; lower
  capacity on an exit) reacted within one tick of the heartbeat, before the
  agent's 180 s stagger would have started the second account.

#### Integration run, login-free part (2026-10-24, on the Mac)

No worker image ran, no Facebook login happened, no pool account was used.
The backend (v1.339.0, then the fix below) ran from a worktree on a free
port against a private database `fleet_f_int_<ts>` on the local
`recycle-erp-testdb` container, migrated and seeded with the repo's scripts,
with a made-up `FB_POOL_KEY` and `FLEET_WORKER_TOKEN_KEY` and
`FLEET_IMAGE_WORKER=fleet-check:sleeper`. One made-up account (`uid
100000000000901`, status `fleet`, `alive_checked_at` set so the liveness
loop never probed it, home city `houston`, no proxy) got its `fleet_slots`
row by hand. The database, the image and every container were removed
afterwards.

What was proven, with timings:

| Step | Result |
| --- | --- |
| `fleet-import.mjs` on `master.toml` | 127 cities, 2 items, 12 search keys in 0.12 s; the first scheduler tick (5 s after boot) wrote **254 ready tasks**, all due at once (`reason added`) |
| Claim (`fleet-fake-worker.mjs`) | 200 with epoch 1, two cookies parsed from the header string, `has_proxy false`, home cities and both items, settings with `lease_minutes 30`, `poll_hold_seconds 50`; the `fb_worker_accounts` stint opened |
| Manual task during a held poll | the imported tasks were pushed a day out by hand so the poll was empty; `POST /api/fleet/tasks` reused the pair's waiting row (priority 100, `manual`) and the held poll returned it **12 ms** after the POST |
| Done → next | events `handed, started, searched, finished, done` recorded; the scheduler wrote the pair's next `cadence` task due exactly `done_at + 1 day` |
| Second worker on the only account | `no_slot`, exit 75, while the first held the lease |
| Epoch bumped by hand while the first held a poll | the next heartbeat (10 s cadence, 7 s after the bump) answered 409 `stale_epoch`; the fake worker exited **75** |
| Add a city | disabled city + `verify-slug` (priority 50) on `enterprise_ssd`. **Bug:** the held poll got it only when its 40 s hold ran out (36 s late); fixed in v1.340.0 (`createCity` notifies), re-run: handed **3 ms** after the POST. The fake worker's `finished {location, matches: true}` enabled the city and set `verified_as`; its two search tasks appeared on the next tick, 25 s later |
| Remove the city | `DELETE` disabled it and cancelled both ready tasks in the same request |
| Agent, observe only | `authoritative=false`, capacity 0: first report 30 ms after start, `last_seen_at` moving every tick (`FLEET_INTERVAL=5`), `report.containers` `[]` |
| Agent, capacity 2 | `PUT` at :30.7 → first `run` at :34.4 (next tick), second at :44.6 (stagger 10 s); both reported running with ports 5901, 5902 on 127.0.0.1 |
| Agent, capacity 1 | picked up on the next tick; `remove` of `-2` logged 34 s after the `PUT`, because `docker stop -t 30` waits out the full grace period on a `sleep` that ignores SIGTERM |
| Agent, `authoritative=false` again (capacity 0) | "observing only" every tick, the running container untouched |
| Agent stop (SIGTERM) | exited at once, containers left running (by design); removed by hand |

Surprises:

- The verify-slug wake bug above (fixed with a test in
  `fleet-claim.test.ts`).
- The agent's tick is serial: while one `docker stop -t 30` runs, nothing is
  reported, so `last_seen_at` goes stale for up to 30 s. Harmless at
  capacity changes; worth knowing before reading a stale host as dead.
- The ERP's workers list keeps the last state (`HEALTHY`) of a worker that
  exited cleanly; only `last_heartbeat_at` shows it is gone.
- The fake worker reports its last task through `next-task` with `wait 0`,
  which can lease it another task it then abandons until the lease runs out
  (30 min). The contract has no "done, hand me nothing" form; a real
  worker that stops cleanly has the same problem.
- `master.toml` carries `date_listed = ["last 7 days", "last 7 days"]` (an
  array); it reaches the claim answer as-is, the worker must accept it.
- With the sleeper image the ERP sees containers but no worker heartbeats,
  as expected; a container the agent starts cannot reach a backend bound to
  `127.0.0.1` on the Mac anyway.

Still open, each needs a real Facebook login and the owner:

| Item | What the owner must provide |
| --- | --- |
| A real claim and exactly one `boot` in the login ledger | a **throwaway** pool account (never a fleet one) imported into the dev pool, with its slot (`fleet-seed-slots.mjs` or by hand); the worker image built on the Mac from the pinned monitor (the mirror is not set up yet) |
| A real search of a manual task | the same, plus the go to start one worker container |
| A listing reaching the coordinator (`rsc` shows the sighting) | route and tokens done 2026-10-26 (*Coordinator wiring* above); with alerts off a fleet worker reports no listing there by design, so this check waits for `RS_ALERTS=on` after prod |
| Stale epoch on the real image: 409, exit 75, agent restart after 60 s, second claim | the go for a **second login** of the throwaway account (expected and noted in the ledger) |
| The agent against the dev backend on a real host | which host (`worker-60-14` per `HOSTS.md`), the GHCR read token, and the host checklist run by the owner |

#### Retiring the 25 unhealthy homelab workers (2026-10-27 UTC, homelab VM + prod pool)

The owner chose "Full retire, archive files". Done 02:30–02:37 UTC with no
deploy, no recreate and no relogin. `rsc vault logins` shows no new row.

**Retired (25):** bos-1, bos-1b, ca-1, ca-1b, ca-2, ca-3b, ca-4, denver-1b,
homelab-1b, mw-1b, ne-1b, nj-1, nj-1b, nj-2, nj-3, nyc-1b, nyc-2, nyc-2b,
nyc-3, nyc-3b, phl-1b, sc-1b, va-1, wc-1 and west-1b. Each one was
re-checked just before it was removed: none was HEALTHY or DEGRADED.

**Kept (16, same container ids and StartedAt before and after):** ca-2b,
ca-3, ca-4b, denver-1, homelab-1, mw-1, ne-1, nj-2b, nj-3b, nyc-1, phl-1,
sc-1, va-2, va-2b, wc-1b and west-1.

What was done:

- **Repo** (PR #935): the 24 `deploy/docker-compose.homelab-*.yml` and
  `configs/homelab-*.toml` files left the tree. va-1's files were already
  gone. rs-console's `RS_WORKER_CONFIGS`, `RS_VNC_TARGETS` and config mounts
  no longer name the retired workers, so `deploy.sh` never recreates them.
  `configs/fleet.toml` keeps `wc-1`: it is the static-region template that
  `gen-configs` checks for coverage, and nothing deploys its output.
- **VM containers:** `rsc queue unenroll <id>`, then `docker stop` and
  `docker rm` by container name. The queue now enrolls the 16 plus the
  pre-existing `se-1` placeholder.
- **VM files:** each worker's `configs/homelab-<x>.toml`,
  `configs/secrets.homelab-<x>.env`, `configs/sessions/homelab-<x>/` and
  `deploy/docker-compose.homelab-<x>.yml` were moved, not deleted, to
  `~/recycle_servers/archive/retired-2026-10-27/facebook_tracker/`. The
  relative paths are unchanged and the folder is mode 700. The VM's previous
  `docker-compose.console.yml` is there as `deploy/docker-compose.console.yml.before`.
  The merged console compose was copied in, and every remaining compose file
  passes `docker compose config`. The `aimm-home-<x>` docker volumes were
  left in place.
- **The running rs-console was not recreated.** Its mounts still point at
  the moved files, which kept their inodes, so it stays harmless until the
  next deploy picks up the new compose.
- **Coordinator:** `retired_at = 2026-10-27T02:34:52+00:00` was set on the 25
  `workers` rows (`db.update_worker_health`, the same field a fleet stop
  sets), so the liveness sweep pages nobody. Their 20 open challenges were
  resolved with `resolved_by = "retired 2026-10-27"`. va-2b's open #22 was
  left alone. The rows stay, so the console still lists the 25, marked
  retired.
- **Prod pool:** 15 accounts went from `fleet` to `problem`. The worker stays
  as holder, as `/assign` does for a problem fate. Each change was one
  transaction with a `reported` event by Jinhu, and the stint trigger closed
  the open stint with outcome `problem`. The accounts: #3 wc-1, #21 ca-2, #23
  ca-4 (locked), #24 nj-1, #25 nj-2, #26 nj-3, #27 bos-1, #28 nyc-2 (locked),
  #34 nyc-3b, #35 nyc-2b, #38 nyc-1b, #40 phl-1b, #42 bos-1b, #46 ca-3b, plus
  #22, ca-3's earlier locked account, which was still `fleet` with an open
  stint. None of these stints had a proxy recorded, so no proxy mark moved.
  Accounts already `problem` without a stint were left as they were: #2, #7,
  #13, #29, #49, #50, #51 and #54. #55, ca-3's current account, still reads
  `available`, which is wrong; it was left untouched.

Bringing one back (worker `<id>`, files `<x>`):

1. On the VM, move its four paths back from the archive to the same places
   under `~/recycle_servers/facebook_tracker/`.
2. In the repo, restore the compose file and seed config from git
   (`git show 015e5ec2^:trackers/facebook/deploy/docker-compose.homelab-<x>.yml`,
   and the same for `configs/homelab-<x>.toml`). Add its lines back to the
   console's `RS_WORKER_CONFIGS`, `RS_VNC_TARGETS` and mounts, and ship that
   as a tracker release.
3. Clear `retired_at` (it also clears on its next fleet start). Then
   `rsc queue enroll <id>` and give it a pool account from the ERP. Starting
   the container is a login: ask the owner first.

## Integration (after A, B, C merge to dev)

- [ ] `pnpm dev` ERP on the Mac with the fleet migration; `fleet-import.mjs`
      against `master.toml`; `fleet-seed-slots.mjs` with one **throwaway**
      pool account (never a live fleet account).
      - Login-free part done 2026-10-24: private local DB, import → 254
        ready tasks, a made-up account's slot by hand. Open: the throwaway
        account.
- [ ] Register host `mac-dev`; run WS-D's agent locally (or `docker run` the
      worker by hand with the three env vars); capacity 1.
      - Login-free part done: host `mac-int`, agent with a sleeping image
        through observe → 2 → 1 → observe. Open: the real worker image.
- [ ] The worker claims, logs in once (ledger: one `boot`), receives a manual
      task within 2 s, searches it, the listing reaches the coordinator
      (`rsc` on the VM shows the sighting), `done` closes the task and the
      scheduler writes tomorrow's.
      - Login-free part done with the fake worker: claim, manual task in
        12 ms, done, tomorrow's task written. Open: login, real search,
        coordinator sighting.
- [ ] Add a city in the ERP → `verify-slug` task → the worker reports the
      label → city enabled; remove → cancelled.
      - Done with the fake worker (it posts the same `finished` event a real
        one does); found and fixed the missing wake. Open: a real worker
        reading the label off Facebook.
- [ ] Claim the same account from a second container → the first gets 409 on
      its next call and exits 75; the agent restarts it after 60 s and it
      claims again (second login — expected, note it).
      - Login-free part done: `no_slot` (75) for a second fake worker, 409
        `stale_epoch` and exit 75 after a hand-bumped epoch. Open: the real
        image's exit and the agent's restart.
- [ ] Record timings and any surprise in this file.
      - Login-free run recorded under *Timings and surprises*; the real run
        still to add.

## Cutover runbook (prod)

> **Superseded by RS-427 (2026-10-27).** The fleet went to prod without new
> logins: prod took dev's fleet rows, slotted pool rows (resealed) and worker
> token key, dev became a mirror (`FLEET_ROLE=mirror`), and the dev Worker
> forwards agent and worker calls to prod. The ticket has the steps; the
> runbook below is kept as the original plan.

0. Owner's yes to start. dev → main release carrying A–E (ERP) and the
   tracker release with the new worker image. Prod env vars set. Imports and
   slot seed run against prod (`memory: fb-pool-prod-import` for creds).
1. Register `worker-60-14` and `homelab` as hosts in prod; start both agents
   `authoritative=false`; confirm reports.
2. **Pilot (4 logins).** In the coordinator: `rsc queue unenroll homelab-1
   nyc-1 phl-1 va-2`. Stop those four compose containers on the VM (`docker
   stop`, not deploy.sh; everything else held). Set `worker-60-14`
   `authoritative=true, capacity=4`. The agent starts 4 workers 3 min apart;
   each claims one of the four accounts (set the other slots' `note`/park so
   only these four are claimable). The old fleet still searches the same
   cities: double coverage for the pilot days, accepted.
3. Watch two days: Queue tab (tasks/day ≈ 2 × cities the four cover),
   Slots minutes vs 360, `rsc vault logins` (only the 4 boots), walls,
   Telegram alerts still arriving. Stop criteria: any checkpoint on a pilot
   account → pause and report.
4. **Everyone (≤ 11 more logins).** Owner's yes. Stop the remaining old
   healthy compose workers a few minutes apart; raise capacity (split between
   `worker-60-14` and `homelab` as the owner decides). Parked accounts stay
   parked until a human re-logs them from the ERP.
5. Coordinator stays for alerts. File the follow-up ticket: retire
   `city_queue`, roster push, `rs_console` fleet routes, the per-worker
   compose files and the ERP's old Fleet tab; update README/FEATURES.
6. `HOSTS.md` and the README status table updated; RS-394 closed with PR and
   versions.

## Exit

- [ ] Every healthy account runs under the ERP fleet; `docker ps` on the VM
      shows only the coordinator, console, agent and fleet workers; no
      per-worker compose, config, secret or session file remains.
