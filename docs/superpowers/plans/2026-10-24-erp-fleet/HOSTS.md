# Hosts (RS-394)

| host_id | Address | Role today | Role in the fleet | Status |
| --- | --- | --- | --- | --- |
| `homelab` | `jinhu@10.10.10.73` | Runs the Python coordinator, console, 41 compose workers, OpenSearch logs | Keeps the coordinator (alerts); becomes a fleet host after cutover (WS-F) | live, do not touch outside WS-F |
| `worker-60-14` | `ssh worker@10.10.60.14` | — | **First fleet host.** Pilot workers run here (WS-F) | named by the owner 2026-10-24; read-only host prep ran the same day (Ubuntu 24.04.5, 8 CPUs, 62 GB, Docker 29.9.2), no container on it. See *Reachability* below |

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
- One container: `sin.ocir.io/ax6usa8hwbie/fleet-agent` with `FLEET_URL`,
  `FLEET_HOST_ID`, `FLEET_HOST_TOKEN`, the Docker socket mounted, restart
  policy `always`. Nothing else on disk: no compose files, no config, no
  secrets, no sessions. The one file that does live there is the registry
  pull credential (`~/.docker/config.json`, below).
- `FLEET_URL` is the ERP's **Cloudflare** hostname,
  `https://inventory-dev.recycleservers.com` for the MVP and
  `https://inventory.recycleservers.com` for prod, never the Railway origin:
  prod's backend refuses requests that lack the Worker's
  `X-Proxy-Secret`. `https://api.recycleservers.com` is not the ERP (it
  answers Cloudflare 522).
- Shared worker secrets are the Cloudflare Worker secret FLEET_WORKER_ENV JSON,
  added only to a successful host-authenticated claim. Provision the edge secret
  before the agent/worker release; these values never enter Railway or Postgres.
- A route to the Python coordinator for listings (`FLEET_COORDINATOR_URL`).
  Today the coordinator is published on the VM's loopback only
  (`127.0.0.1:8500`); workers on the VM reach it as `http://rs-coordinator:8500`
  over the `rs-fleet` Docker network. A worker on another host needs the LAN
  publish (`deploy/docker-compose.coordinator-lan.yml`, `RS_LAN_IP=10.10.10.73`
  in `configs/secrets.coordinator-lan.env`, firewall opened for the host) or a
  tunnel hostname. **Owner decision; not enabled yet.** The dev ERP carries
  `FLEET_COORDINATOR_URL=http://10.10.10.73:8500` as the intended LAN address.

## Registry: OCI Container Registry, private

The images live in OCI Container Registry (OCIR), not GHCR (owner's
decision, 2026-10-24). Both repositories are **private**: the worker image
carries the AGPL-3 monitor, which is never distributed. An anonymous pull is
refused (`DENIED: Anonymous users are only allowed read access on public
repos`, checked when they were created).

| What | Value |
| --- | --- |
| Registry host | `sin.ocir.io` (region `ap-singapore-1`; `ap-singapore-1.ocir.io` is the same registry) |
| Tenancy | `developjinhu`, Pay-As-You-Go, the one behind `~/.oci/config` profile `DEFAULT` / `DEFAULT_UNENCRYPTED` (the Reddit fleet's) |
| Namespace | `ax6usa8hwbie` |
| Repositories | `aimm-recycle`, `fleet-agent`, both `is_public=false`, compartment: the tenancy root (the Reddit infra uses no other), tagged `purpose=erp-fleet` |
| Worker image | `sin.ocir.io/ax6usa8hwbie/aimm-recycle:<trackers/facebook/VERSION>` |
| Agent image | `sin.ocir.io/ax6usa8hwbie/fleet-agent:<root package.json version>` |
| Login user | `ax6usa8hwbie/<OCI login>`, the login name of the IAM user behind profile `DEFAULT` (a local user; a federated one would be `ax6usa8hwbie/oracleidentitycloudservice/<login>`) |
| Password | an OCI **auth token** of that user, never its console password |
| Where the token lives | the Mac's login keychain, item account `fleet-ocir`, service `fleet-ocir`; on each host only inside `~/.docker/config.json` |

**Why this tenancy and region.**

- OCIR has no fee of its own; stored images are billed at the Object
  Storage *Standard* rate (Oracle's Container Registry page and the
  Registry overview, "You are charged for stored images"). Always Free
  covers 10 GB of Standard storage on a paid tenancy and 20 GB on an
  Always-Free-only one, and the free outbound allowance is 10 TB a month.
  The two repositories hold about 3 GB (the worker image is ≈ 2.5 GB, the
  agent ≈ 60 MB, three tags each kept), and the tenancy's only bucket holds
  22 MB. Oracle does not say in so many words that registry storage draws on
  the Object Storage free allotment; if it does not, 3 GB costs about $0.08
  a month at the list Standard rate. Either way it is not worth more than
  that.
- The North American tenancy (profile `jinhuwang112`, home `ca-toronto-1`)
  was the first choice for a US host, but it is Always-Free-only and OCIR
  refuses such tenancies outright: `403 FREE_TIER_NOT_SUPPORTED`, "Free tier
  account is not supported" on `ListContainerRepositories`. It would need an
  upgrade to Pay-As-You-Go first.
- `developjinhu` is subscribed to `ap-singapore-1` only. Subscribing it to a
  US region is permanent (OCI cannot unsubscribe a region) and is the
  owner's call. Pulls from the US host cross the Pacific once per new tag;
  the image layers are cached on the host after that.

**Retention.** The OCI API this was built with (SDK 2.189) has no retention
or cleanup policy for container repositories, so cleanup is manual: keep the
newest 3 tags of each repository. Console → Developer Services → Container
Registry → repository → image → *Delete*, or with the OCI SDK
`ArtifactsClient.list_container_images(compartment_id=<tenancy>,
repository_name="aimm-recycle", sort_by="TIMECREATED")` and
`delete_container_image(image_id)` for all but the newest three. Never delete
the tag the fleet's current release (`fleet_settings.release`) or
`FLEET_IMAGE_WORKER` names: an agent that cannot pull it cannot replace a
worker.

**Known limitation: the hosts hold a push-capable token.** OCIR auth tokens
are not scoped; whoever holds one can do what its user can, which includes
pushing. The better form, later: a separate IAM user `fleet-pull` in a group
with only `allow group fleet-pull to read repos in tenancy`, and its own
auth token on the hosts. A user holds at most two auth tokens.

### The token (once, on the Mac)

```bash
# OCI console → Identity → Users → <the DEFAULT profile's user> → Auth tokens
#   → Generate token, description "fleet OCIR push/pull 2026-10-24"
# (or IdentityClient.create_auth_token from the SDK). Then, without echoing it:
security add-generic-password -a fleet-ocir -s fleet-ocir -U -w   # prompts twice, nothing echoes
```

### Logins

```bash
# on the Mac (to push)
security find-generic-password -a fleet-ocir -s fleet-ocir -w \
  | docker login sin.ocir.io -u 'ax6usa8hwbie/<OCI login>' --password-stdin

# on worker@10.10.60.14 (to pull), fed from the Mac's keychain over ssh
security find-generic-password -a fleet-ocir -s fleet-ocir -w \
  | ssh worker@10.10.60.14 "docker login sin.ocir.io -u 'ax6usa8hwbie/<OCI login>' --password-stdin"
```

A new token takes a minute or two before the registry accepts it. Prove
both logins with a throwaway tag (no container is started anywhere):

```bash
docker pull --platform linux/amd64 alpine:3
docker tag alpine:3 sin.ocir.io/ax6usa8hwbie/fleet-agent:login-check
docker push sin.ocir.io/ax6usa8hwbie/fleet-agent:login-check
ssh worker@10.10.60.14 'docker pull sin.ocir.io/ax6usa8hwbie/fleet-agent:login-check && docker rmi sin.ocir.io/ax6usa8hwbie/fleet-agent:login-check'
# then delete the login-check image from the repository (console, or the SDK's delete_container_image)
```

`docker login` writes the credential to `~/.docker/config.json` (base64, not
encrypted). The fleet agent pulls worker images through the Docker CLI inside
its own container, so that file is mounted into it read-only (the one-liner
below); the agent image itself is pulled by the host's own `docker run`.

### Building and pushing

`trackers/facebook/scripts/push-fleet-images.sh` builds both images for
`linux/amd64` on the Mac (buildx, builder `multiarch` on Colima) and pushes
them: the worker from `trackers/facebook/deploy/Dockerfile.worker` with
`RS_VERSION` and `RS_MONITOR_COMMIT` as `deploy.sh` passes them, refusing a
monitor clone that is not at the `VENDOR.md` pin or is dirty, and refusing
to push a tracker tree that is not a release (`check-release-tag.sh`); the
agent from `apps/fleet-agent/Dockerfile` at the root package version.
`--no-push` builds only, `--only worker|agent` picks one.
`.github/workflows/fleet-images.yml` (GHCR) is superseded for now; its
header says what pushing to OCIR from CI would take.

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
  echo "== outbound ocir";    curl -sS -o /dev/null -w "ocir %{http_code}\n" https://sin.ocir.io/v2/
  echo "== coordinator lan";  (command -v nc >/dev/null && nc -z -w 3 10.10.10.73 8500 && echo "10.10.10.73:8500 open" || echo "10.10.10.73:8500 closed (expected until the LAN publish is enabled)")
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
| `ocir 401` | 401 (anonymous is refused, but the host reaches the registry) | a 000 means no route to OCI's Singapore registry |
| `10.10.10.73:8500` | `closed` today | `open` only once the owner enabled the LAN publish on the VM |
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

## After the checklist: owner steps, in order

1. **Registry login** on the host (*Logins* above, fed from the Mac's
   keychain). Confirm with the `login-check` pull, then with a pull of the
   agent image once `push-fleet-images.sh --only agent` has pushed it.
2. **Register the host** in the ERP: Hosts tab → Add host `worker-60-14` →
   copy the token once (WS-B and WS-E). Until the tabs exist:
   `POST /api/fleet/hosts {"host_id":"worker-60-14"}` as a manager.
3. **Start the agent, observe-only** (the host stays `authoritative=false`
   in the ERP, so the agent starts nothing):

   ```bash
   docker run -d --name rs-fleet-agent --restart always \
     -e FLEET_URL=https://inventory-dev.recycleservers.com \
     -e FLEET_HOST_ID=worker-60-14 \
     -e FLEET_HOST_TOKEN="$(cat ~/.fleet-host-token)" \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v /home/worker/.docker/config.json:/root/.docker/config.json:ro \
     -v rs-fleet-agent-state:/state \
     sin.ocir.io/ax6usa8hwbie/fleet-agent:<root version>
   docker logs -f rs-fleet-agent      # one JSON line per loop: desired fetched, 0 containers, report sent
   ```

   `~/.fleet-host-token` holds the token from step 2, mode 0600, written by
   the owner; the only other secret on the host is the registry login in
   `~/.docker/config.json`. `FLEET_URL` above is the MVP's (the dev ERP
   behind Cloudflare); prod is `https://inventory.recycleservers.com`. Never
   the Railway origin: the shared worker secrets are added by the Cloudflare
   Worker, and prod's backend refuses a request without its proxy secret.
4. Confirm `last_seen_at` moves in the Hosts tab.
5. **Owner's yes** → `authoritative=true`, capacity 4 for the pilot. Each
   worker the agent then starts is a Facebook login (root `AGENTS.md`).

## Host prep checklist (plan form)

- [x] Read-only block run 2026-10-24 (with the ERP check against
      `inventory-dev` and the registry check against `iad.ocir.io`); output in
      `WS-F-ops-and-cutover.md` → *Timings and surprises*
- [ ] Outbound: ERP 200, `sin.ocir.io` 401 (only `iad.ocir.io` was checked), proxy exit from the VM
- [x] OCIR repositories `aimm-recycle`, `fleet-agent` created private (2026-10-24)
- [ ] Auth token in the Mac's keychain (`fleet-ocir`); `docker login sin.ocir.io` on the Mac and on the host, proven with `login-check`
- [ ] Register in the ERP: Hosts tab → Add host `worker-60-14` → copy the
      token once
- [ ] Start the agent with `authoritative=false` (observe only) and confirm
      `last_seen_at` moves in the Hosts tab
- [ ] Owner's yes → `authoritative=true`, capacity 4 for the pilot
