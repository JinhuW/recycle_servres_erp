# Hosts (RS-394)

| host_id | Address | Role today | Role in the fleet | Status |
| --- | --- | --- | --- | --- |
| `homelab` | `jinhu@10.10.10.73` | Runs the Python coordinator, console, 41 compose workers, OpenSearch logs | Keeps the coordinator (alerts); becomes a fleet host after cutover (WS-F) | live, do not touch outside WS-F |
| `worker-60-14` | `ssh worker@10.10.60.14` | — | **First fleet host.** Pilot workers run here (WS-F) | named by the owner 2026-10-24; **not reachable from the Mac mini** (`10.10.100.225`, timeout on port 22). Verify from the owner's machine or a route into `10.10.60.0/24` |

## What a fleet host needs

- Linux amd64, Docker Engine 24+, outbound HTTPS to the ERP and to the
  residential proxy provider, ≥ 2 GB RAM per worker (Chromium + Xvfb), ≥ 20 GB
  disk for images and logs.
- No inbound ports. VNC and logs go out to the ERP.
- A non-root user in the `docker` group (the owner uses `worker`).
- One container: `ghcr.io/jinhuw/fleet-agent` with `FLEET_URL`,
  `FLEET_HOST_ID`, `FLEET_HOST_TOKEN`, the Docker socket mounted, restart
  policy `always`. Nothing else on disk: no compose files, no config, no
  secrets, no sessions.

## Host prep checklist (WS-F runs it, read-only until the owner says go)

- [ ] `ssh worker@10.10.60.14 'uname -mr; nproc; free -g; df -h /; docker --version; id'`
- [ ] Outbound: `curl -sI https://api.recycleservers.com/api/health`, and one
      proxy exit through the Decodo credentials from the VM's `secrets.env`
- [ ] Register in the ERP: Hosts tab → Add host `worker-60-14` → copy the
      token once
- [ ] Start the agent with `authoritative=false` (observe only) and confirm
      `last_seen_at` moves in the Hosts tab
- [ ] Owner's yes → `authoritative=true`, capacity 4 for the pilot
