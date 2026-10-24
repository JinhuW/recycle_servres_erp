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
         `tcp/22` from the Mac at 21:30 UTC on 2026-10-24 after being
         unreachable earlier that day (`HOSTS.md` → *Reachability*).
   - [ ] Owner runs the block and pastes the output into *Timings and
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
scratch directory on the operator's machine that is deleted afterwards. None
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
  reachable (ping, tcp/22) at 21:30 UTC; not logged in. The homelab VM
  reaches it too.
- 2026-10-24: the live workers carry `RS_COORDINATOR_URL=http://coordinator.tailnet:8500`
  (the example value; no tailnet interface on the VM) and
  `RS_CONTROL_PLANE_URL=http://rs-coordinator:8500`. Only the second
  resolves, over the `rs-fleet` network. The coordinator is published on
  `127.0.0.1:8500` only; `configs/secrets.coordinator-lan.env` does not exist
  on the VM, so the LAN publish is off.
- Host checklist output: (owner pastes here)
- Integration run: (timings here)

## Integration (after A, B, C merge to dev)

- [ ] `pnpm dev` ERP on the Mac with the fleet migration; `fleet-import.mjs`
      against `master.toml`; `fleet-seed-slots.mjs` with one **throwaway**
      pool account (never a live fleet account).
- [ ] Register host `mac-dev`; run WS-D's agent locally (or `docker run` the
      worker by hand with the three env vars); capacity 1.
- [ ] The worker claims, logs in once (ledger: one `boot`), receives a manual
      task within 2 s, searches it, the listing reaches the coordinator
      (`rsc` on the VM shows the sighting), `done` closes the task and the
      scheduler writes tomorrow's.
- [ ] Add a city in the ERP → `verify-slug` task → the worker reports the
      label → city enabled; remove → cancelled.
- [ ] Claim the same account from a second container → the first gets 409 on
      its next call and exits 75; the agent restarts it after 60 s and it
      claims again (second login — expected, note it).
- [ ] Record timings and any surprise in this file.

## Cutover runbook (prod)

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
