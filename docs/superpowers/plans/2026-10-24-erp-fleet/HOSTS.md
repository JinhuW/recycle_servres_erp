# Hosts (RS-394)

| host_id | Address | Role today | Role in the fleet | Status |
| --- | --- | --- | --- | --- |
| `homelab` | `jinhu@10.10.10.73` | Runs the Python coordinator, console, 41 compose workers, OpenSearch logs | Keeps the coordinator (alerts); becomes a fleet host after cutover (WS-F) | live, do not touch outside WS-F |
| `worker-60-14` | `ssh worker@10.10.60.14` | — | **First fleet host.** Pilot workers run here (WS-F) | named by the owner 2026-10-24; nothing has been run on it yet. See *Reachability* below |

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
- The first command on the host is the owner's. Nobody has pasted the
  checklist yet; the WS-F agent of 2026-10-24 did not ssh to it.

## What a fleet host needs

- Linux amd64, Docker Engine 24+, outbound HTTPS to the ERP and to the
  residential proxy provider, ≥ 2 GB RAM per worker (Chromium + Xvfb), ≥ 20 GB
  disk for images and logs.
- No inbound ports. VNC and logs go out to the ERP.
- A non-root user in the `docker` group (the owner uses `worker`).
- One container: `ghcr.io/jinhuw/fleet-agent` with `FLEET_URL`,
  `FLEET_HOST_ID`, `FLEET_HOST_TOKEN`, the Docker socket mounted, restart
  policy `always`. Nothing else on disk: no compose files, no config, no
  secrets, no sessions. The one file that does live there is the GHCR pull
  credential (`~/.docker/config.json`, below).
- A route to the Python coordinator for listings (`FLEET_COORDINATOR_URL`).
  Today the coordinator is published on the VM's loopback only
  (`127.0.0.1:8500`); workers on the VM reach it as `http://rs-coordinator:8500`
  over the `rs-fleet` Docker network. A worker on another host needs the LAN
  publish (`deploy/docker-compose.coordinator-lan.yml`, `RS_LAN_IP=10.10.10.73`
  in `configs/secrets.coordinator-lan.env`, firewall opened for the host) or a
  tunnel hostname. **Owner decision; not enabled yet.** The dev ERP carries
  `FLEET_COORDINATOR_URL=http://10.10.10.73:8500` as the intended LAN address.

## GHCR: the images are private

Both packages (`ghcr.io/jinhuw/aimm-recycle`, `ghcr.io/jinhuw/fleet-agent`)
are private: the worker image carries the AGPL-3 monitor, which is never
distributed. `.github/workflows/fleet-images.yml` builds and pushes them; its
header lists the owner steps that create the packages private and grant the
repository write access before the first push.

A host pulls with a **read-only token**, which the owner creates once
(fine-grained PATs cannot read packages; this is a classic PAT with the single
scope `read:packages`, github.com → Settings → Developer settings → Personal
access tokens → Tokens (classic)):

```bash
# on the host, as user `worker`
read -rs GHCR_READ_TOKEN           # paste the read:packages token, nothing echoes
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u JinhuW --password-stdin
unset GHCR_READ_TOKEN
docker pull ghcr.io/jinhuw/fleet-agent:<root version>    # proves the login
```

`docker login` writes the credential to `~/.docker/config.json` (base64, not
encrypted). The fleet agent pulls worker images through the Docker CLI inside
its own container, so that file is mounted into it read-only (the one-liner
below); the agent image itself is pulled by the host's own `docker run`.

## Host prep checklist for `worker-60-14` (owner-runnable, read-only)

Paste the block into a shell on the owner's machine (or on the homelab VM).
It changes nothing on the host. Expected answers follow each command.

```bash
ssh worker@10.10.60.14 '
  echo "== os/cpu/mem/disk";  uname -mr; nproc; free -g | sed -n 1,2p; df -h / | sed -n 1,2p
  echo "== docker";           docker --version; docker info --format "{{.ServerVersion}} {{.OSType}}/{{.Architecture}} cgroup={{.CgroupVersion}}" 2>&1
  echo "== user";             id; groups
  echo "== containers";       docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" 2>&1
  echo "== outbound erp";     curl -sS -o /dev/null -w "erp api %{http_code} in %{time_total}s\n" https://api.recycleservers.com/api/health
  echo "== outbound ghcr";    curl -sS -o /dev/null -w "ghcr %{http_code}\n" https://ghcr.io/v2/
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
| `erp api 200` | 200 within a second or two | no outbound HTTPS: the host is useless for the fleet |
| `ghcr 401` | 401 (anonymous is refused, but the host reaches ghcr.io) | a 000 means no route to GitHub |
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

1. **GHCR read token** on the host (block above). Confirm with the
   `docker pull` of the agent image. The pull needs the agent image to exist
   (WS-D merged, root tag built by `fleet-images.yml`).
2. **Register the host** in the ERP: Hosts tab → Add host `worker-60-14` →
   copy the token once (WS-B and WS-E). Until the tabs exist:
   `POST /api/fleet/hosts {"host_id":"worker-60-14"}` as a manager.
3. **Start the agent, observe-only** (the host stays `authoritative=false`
   in the ERP, so the agent starts nothing):

   ```bash
   docker run -d --name rs-fleet-agent --restart always \
     -e FLEET_URL=https://api.recycleservers.com \
     -e FLEET_HOST_ID=worker-60-14 \
     -e FLEET_HOST_TOKEN="$(cat ~/.fleet-host-token)" \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v "$HOME/.docker/config.json:/root/.docker/config.json:ro" \
     -v rs-fleet-agent-state:/state \
     ghcr.io/jinhuw/fleet-agent:<root version>
   docker logs -f rs-fleet-agent      # one JSON line per loop: desired fetched, 0 containers, report sent
   ```

   `~/.fleet-host-token` holds the token from step 2, mode 0600, written by
   the owner; nothing else on the host holds a secret. Point `FLEET_URL` at
   `https://api.dev.recycleservers.com` for the integration run first.
4. Confirm `last_seen_at` moves in the Hosts tab.
5. **Owner's yes** → `authoritative=true`, capacity 4 for the pilot. Each
   worker the agent then starts is a Facebook login (root `AGENTS.md`).

## Host prep checklist (plan form)

- [ ] Read-only block above pasted and its output recorded in
      `WS-F-ops-and-cutover.md` → *Timings and surprises*
- [ ] Outbound: ERP 200, ghcr 401, proxy exit from the VM
- [ ] GHCR read token created by the owner; `docker login` on the host
- [ ] Register in the ERP: Hosts tab → Add host `worker-60-14` → copy the
      token once
- [ ] Start the agent with `authoritative=false` (observe only) and confirm
      `last_seen_at` moves in the Hosts tab
- [ ] Owner's yes → `authoritative=true`, capacity 4 for the pilot
