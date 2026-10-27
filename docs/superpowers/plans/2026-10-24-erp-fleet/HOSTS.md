# Hosts (RS-394)

| host_id | Address | Role today | Role in the fleet | Status |
| --- | --- | --- | --- | --- |
| `homelab` | `jinhu@10.10.10.73` | Python coordinator, console, OpenSearch and four ERP fleet workers; all legacy monitor launches retired | Active dev fleet host, capacity 4 | RS-426, 2026-10-27; sessions restored once, alerts off |
| `worker-60-14` | `worker@10.10.60.14` | Eight running ERP worker containers and one parked container on operator hold | First dev fleet host, capacity 13 | Existing containers retained during RS-426; SESSION_EXPIRED workers left untouched |

## Reachability of `10.10.60.14`

- Earlier on 2026-10-24 the host did not answer on port 22 from the Mac mini
  (`10.10.100.225`). At about 20:40 UTC the same day it did: `ping` answered in 4 ms
  and `nc -z 10.10.60.14 22` connected, routed through the Mac's gateway
  `10.10.100.1` on `en1`. Nothing was logged in. If it goes dark again, the
  problem is on the Mac's side (a different subnet, `10.10.100.0/24` →
  `10.10.60.0/24`, through the gateway), not on the host.
- From the homelab VM (`10.10.10.73`, second interface `10.10.10.14`) the
  host answers `ping` too. The VM is the fallback place to run the checklist
  from if the Mac's route breaks.
- The read-only checklist ran on 2026-10-24 (output in
  `WS-F-ops-and-cutover.md` → *Timings and surprises*). No container has
  been started there.

## What a fleet host needs

- Linux amd64, Docker Engine 24+, outbound HTTPS to the ERP and to the
  residential proxy provider, ≥ 2 GB RAM per worker (Chromium + Xvfb), ≥ 20 GB
  disk for images and logs.
- No inbound ports. VNC and logs go out to the ERP.
- A non-root user in the `docker` group (the owner uses `worker`).
- One container: `ghcr.io/jinhuw/fleet-agent` with `FLEET_URL`,
  `FLEET_HOST_ID`, `FLEET_HOST_TOKEN` (from `~/.config/fleet-agent.env`,
  mode 0600), the Docker socket mounted, restart policy `always`. Nothing
  else on disk: no compose files, no config, no secrets, no sessions. The
  two files that do live there are that env file and the registry pull
  credential (`~/.docker/config.json`, below).
- The host token stays in the agent. Each worker container gets a
  single-use claim ticket the agent mints for it right before `docker run`
  (`CONTRACTS.md` §6), so a compromised worker can claim no other account
  and call no host route. Bring a held worker back with `docker rm
  rs-fleet-<worker_id>`; `docker start` claims with a spent ticket, exits
  `75` and is recreated on the agent's next turn.
- `FLEET_URL` is the ERP's **Cloudflare** hostname,
  `https://inventory-dev.recycleservers.com` for the MVP and
  `https://inventory.recycleservers.com` for prod, never the Railway origin:
  prod's backend refuses requests that lack the Worker's
  `X-Proxy-Secret`. `https://api.recycleservers.com` is not the ERP (it
  answers Cloudflare 522).
- Shared worker secrets are the Cloudflare Worker secret FLEET_WORKER_ENV JSON,
  added only to a successful host-authenticated claim. Provision the edge secret
  before the agent/worker release; these values never enter Railway or Postgres.
- A route to the Python coordinator (`FLEET_COORDINATOR_URL`), below.

## Coordinator route

The coordinator publishes only on loopback (`127.0.0.1:8500`). Legacy
containers reached it by name on `rs-fleet`; ERP workers use the separate LAN
relay at `10.10.10.73:8500`, so the coordinator does not need recreation.

The original socat relay (2026-10-26) admitted only worker-60-14. During the
2026-10-27 homelab migration it rejected local Docker hairpin traffic, seen
as `172.24.0.1`. RS-426 replaced only that relay with pinned HAProxy. No coordinator, console or worker browser was restarted. The peer host agent
was reloaded once to hold its pre-existing expired, stopped worker.

| What | Current value |
| --- | --- |
| Container | `rs-coordinator-lan`, pinned `haproxy:3.2-alpine@sha256:5893840576071e6217cd52ebdcc14f454c6f7a631056fa6f4e0f40d3cac4215b` |
| Compose/config | `trackers/facebook/deploy/docker-compose.coordinator-relay.yml` and `coordinator-relay.cfg` |
| Listens | `10.10.10.73:8500`; the coordinator keeps its separate loopback publish |
| Destination | `rs-coordinator:8500` on `rs-fleet`, with Docker DNS re-resolution |
| Allowed sources | `10.10.60.14/32` and local Docker hairpin gateway `172.24.0.1/32` |
| Limits | 64 MB, one HAProxy thread, 128 connections, capped logs |
| Backend setting | Dev `FLEET_COORDINATOR_URL=http://10.10.10.73:8500`, unchanged |
| Rollback | Original socat container retained stopped as `rs-coordinator-lan-socat-rollback-20261027` |

Manage only the relay from the tracker directory on homelab:

```bash
docker compose -f deploy/docker-compose.coordinator-relay.yml config --quiet
docker compose -f deploy/docker-compose.coordinator-relay.yml run --rm --no-deps --entrypoint haproxy coordinator-relay -c -f /usr/local/etc/haproxy/haproxy.cfg
docker compose -f deploy/docker-compose.coordinator-relay.yml up -d --no-deps coordinator-relay
```

Both worker hosts returned 200 from `/healthz` after the change. The homelab
VM itself remains rejected because its LAN source address is not allowed.
A homelab worker token was authenticated but refused (403) when requesting
another worker's session. Extend the explicit ACL and validate it before
adding another host; do not open it to the whole LAN. The older
`docker-compose.coordinator-lan.yml` is a coordinator port override, not
this relay's compose file.

The first canary restored before the relay correction, so its coordinator
ledger request was lost. Its one restored boot is verified from container
start/claim/log evidence; no audit row was fabricated and no browser rebooted.
All subsequent active handovers recorded one restored boot in the ledger.
Full details and backup references are in WS-H-migration.md.

Auth: per-worker tokens, `docker exec rs-coordinator rsc mint-token --worker
<worker id>`, carried to the workers in the Cloudflare secret
`FLEET_WORKER_ENV` as `RS_CONTROL_PLANE_TOKENS` (piped from the VM into
`wrangler secret put`, never printed or written to disk).

What a fleet worker does there while alerts are off (`RS_ALERTS` unset, dev
today): it records its logins in the coordinator's ledger, and its 2FA-code
and session-token asks answer 404 (the coordinator has no account for a fleet
worker id), after which it uses the claim's TOTP and password. It claims no
alert, reports no searched city, funnel count, wall or incident, and sends no
heartbeat (those go to the ERP). The coordinator's listing dedupe does **not**
shorten a search: which listings a worker opens is decided by the worker's own
listing cache (`Listing.from_cache`, in the container's
`~/.ai-marketplace-monitor`, lost when the container is replaced); the
coordinator only dedupes *alerts*, after the listing was opened and judged.

## Registry: GitHub Container Registry, private

The images live in **GHCR** as private user packages. The owner's rule
(2026-10-25): use GHCR while it works, and push nothing to OCI. The OCI
Container Registry repositories created on 2026-10-24
(`sin.ocir.io/ax6usa8hwbie/{aimm-recycle,fleet-agent}`, Pay-As-You-Go
Singapore tenancy) stay empty as the fallback.

| What | Value |
| --- | --- |
| Worker image | `ghcr.io/jinhuw/aimm-recycle:<trackers/facebook/VERSION>` |
| Agent image | `ghcr.io/jinhuw/fleet-agent:<root package.json version>` |
| Visibility | private (a package first pushed with a user token starts private; an anonymous token request answers 401) |
| Push credential | the Mac's `gh` CLI token, which carries `write:packages`: `gh auth token \| docker login ghcr.io -u jinhuw --password-stdin` |
| Pull credential on a host | a classic PAT with only `read:packages`, the same one the Reddit tracker's OCI workers use (`GHCR_READ_TOKEN` in `trackers/reddit/scripts/secrets.env`, gitignored), in the host's `~/.docker/config.json` (mode 0600) |

Log a host in without the token touching a terminal:

```bash
F=trackers/reddit/scripts/secrets.env
sed -n 's/^GHCR_READ_TOKEN=//p' $F \
  | ssh worker@10.10.60.14 "docker login ghcr.io -u $(sed -n 's/^GHCR_USERNAME=//p' $F) --password-stdin"
```

**Never re-push a tag.** On 2026-10-25 `aimm-recycle:0.14.1` was pushed twice
(the second build added RS-400's worker changes). The host had already pulled
the first one, and the agent pulls only a *missing* image, so the first real
worker ran the stale build. A fix after a push gets a new version.

### Building and pushing

`trackers/facebook/scripts/push-fleet-images.sh` builds both images for
`linux/amd64` on the Mac (buildx, builder `multiarch` on Colima) and pushes
them: the worker from `trackers/facebook/deploy/Dockerfile.worker` with
`RS_VERSION` and `RS_MONITOR_COMMIT` as `deploy.sh` passes them, refusing a
monitor clone that is not at the `VENDOR.md` pin or is dirty, and refusing
to push a tracker tree that is not a release (`check-release-tag.sh`); the
agent from `apps/fleet-agent/Dockerfile` at the root package version.
`--no-push` builds only, `--only worker|agent` picks one; `REGISTRY` and
`NAMESPACE` select the OCI fallback. `.github/workflows/fleet-images.yml`
cannot build the worker image without a private mirror of the vendored
monitor, so images are pushed from the Mac.

## Host prep checklist for `worker-60-14` (owner-runnable, read-only)

Paste the block into a shell on the owner's machine (or on the homelab VM).
It changes nothing on the host. Expected answers follow each command.

```bash
ssh worker@10.10.60.14 '
  echo "== os/cpu/mem/disk";  uname -mr; nproc; free -g | sed -n 1,2p; df -h / | sed -n 1,2p
  echo "== docker";           docker --version; docker info --format "{{.ServerVersion}} {{.OSType}}/{{.Architecture}} cgroup={{.CgroupVersion}}" 2>&1
  echo "== user";             id; groups
  echo "== containers";       docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" 2>&1
  echo "== outbound erp";     curl -sS -o /dev/null -w "erp %{http_code} in %{time_total}s\n" https://inventory-dev.recycleservers.com/api/health
  echo "== outbound ghcr";    curl -sS -o /dev/null -w "ghcr %{http_code}\n" https://ghcr.io/v2/
  echo "== coordinator lan";  (command -v nc >/dev/null && nc -z -w 3 10.10.10.73 8500 && echo "10.10.10.73:8500 open" || echo "10.10.10.73:8500 closed (open only for hosts the rs-coordinator-lan forwarder admits)")
  echo "== time";             timedatectl 2>/dev/null | grep -E "Time zone|synchronized" || date -u
'
```

| Line | Expected | If not |
| --- | --- | --- |
| `uname -mr` | `x86_64` and a 5.x/6.x kernel | an arm64 host needs the images built for it; stop and report |
| `nproc`, `free -g` | ≥ 4 CPUs, ≥ 10 GB total for the 4-worker pilot (2 GB per worker + headroom) | lower the pilot capacity |
| `df -h /` | ≥ 20 GB free | prune or add disk before pulling images (the worker image is ≈ 2.5 GB) |
| `docker --version`, `docker info` | Engine 24 or newer, `linux/x86_64`, `cgroup=2` | install Docker Engine from docker.com's apt repo, not the distro package |
| `id` | `worker` is in group `docker` | `sudo usermod -aG docker worker`, re-login (an owner step, not read-only) |
| `docker ps -a` | empty, or only things the owner knows | anything else sharing the host is worth knowing before the pilot |
| `erp 200` | 200 within a second or two | no outbound HTTPS: the host is useless for the fleet |
| `ghcr 401` | 401 (anonymous is refused, but the host reaches the registry) | a 000 means no route to GitHub |
| `10.10.10.73:8500` | `open` from `10.10.60.14` since 2026-10-26 (`rs-coordinator-lan`); `closed` from any other host | the forwarder is down (`docker ps` on the VM) or the host is not in its source allowlist |
| time | synchronized, any zone | worker tokens expire by wall clock; fix NTP first |

Paste the whole output back; it goes into *Timings and surprises* in
`WS-F-ops-and-cutover.md`.

The proxy exit check (one request through the Decodo credentials from the
VM's `secrets.env`) is **not** in this block: it needs a proxy login, which is
read on the VM and never typed onto another host. Run it from the VM instead:

```bash
# on jinhu@10.10.10.73, in ~/recycle_servers/facebook_tracker
set -a; . configs/secrets.env; set +a
curl -sS --proxy "$PROXY_HOMELAB_NYC" --proxy-user "$PROXY_HOMELAB_NYC_USER:$PROXY_HOMELAB_NYC_PASS" https://ip.decodo.com/json
```

## After the checklist: the steps as run on 2026-10-25

1. **Registry login** on the host (*Registry* above), then `docker pull`
   both images.
2. **Register the host** on the dev ERP. The Hosts tab or
   `POST /api/fleet/hosts {"host_id":"worker-60-14"}` as a manager shows the
   token once. On 2026-10-25 the row was inserted with SQL instead (the
   token generated on the Mac, only its sha256 stored), because no dev manager
   login was at hand.
3. **Write the host's env file** (the token travels over ssh stdin):

   ```bash
   printf 'FLEET_URL=https://inventory-dev.recycleservers.com\nFLEET_HOST_ID=worker-60-14\nFLEET_HOST_TOKEN=%s\n' "$TOKEN" \
     | ssh worker@10.10.60.14 'umask 077; mkdir -p ~/.config && cat > ~/.config/fleet-agent.env'
   ```

4. **Start the agent, observe-only** (`authoritative=false`, so it starts
   nothing):

   ```bash
   docker run -d --name rs-fleet-agent --restart always --stop-timeout 120 \
     --log-opt max-size=10m --log-opt max-file=3 \
     --env-file /home/worker/.config/fleet-agent.env \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v /home/worker/.docker/config.json:/root/.docker/config.json:ro \
     -v rs-fleet-agent-state:/state \
     ghcr.io/jinhuw/fleet-agent:<root version>
   docker logs -f rs-fleet-agent      # one JSON line per tick
   ```

   Replacing the agent container (a new agent version) is safe at any time:
   it runs no Facebook account, and `rs-fleet-agent-state` keeps its
   confirmed-stop state, holds and instance id. Remove the old agent before
   starting the new one: an agent that sees another running agent for the
   same host observes only until it is gone. `--stop-timeout 120` lets a
   tick finish its `docker stop` and write it down. Never remove an
   `rs-fleet-worker-*` container by hand while it runs an account (owner's
   rule, 2026-10-25).

   A worker the agent holds (report `state` `operator_needed`,
   `crash_limit` or `operator_stopped`) stays stopped until a person acts:
   `docker rm rs-fleet-<worker_id>` lets the agent run a fresh one on its
   turn; `docker start` works only for a container without the
   `rs.fleet.handoff_epoch` label. `docker stop` on a worker is now a hold,
   not a pause: the agent does not start it again.
5. Confirm `last_seen_at` moves.
6. **Owner's yes** → `authoritative=true`, capacity N. Each worker the agent
   starts is a Facebook login (root `AGENTS.md`).

## Host prep checklist (plan form)

- [x] Read-only block run 2026-10-24; output in `WS-F-ops-and-cutover.md` → *Timings and surprises*
- [x] Outbound: `inventory-dev` 200, `ghcr.io` 401
- [x] GHCR read login on the host (2026-10-25); both images pulled
- [x] Host `worker-60-14` registered on the dev ERP; env file `~/.config/fleet-agent.env` (0600)
- [x] Agent started observe-only; `last_seen_at` moving (2026-10-26 02:09 UTC)
- [x] Owner's yes → `authoritative=true`, capacity 1 for the MVP (retired account #37)
- [ ] Pilot capacity 4 with live accounts (cutover, owner's yes)
