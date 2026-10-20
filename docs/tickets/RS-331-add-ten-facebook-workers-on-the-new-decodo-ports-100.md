---
id: RS-331
title: Add ten Facebook workers on the new Decodo ports 10011-10020
type: task
status: in-progress
priority: P2
created: 2026-10-20
reporter: jinhu
branch: add-new-proxy-workers
pr:
version:
related: [RS-275, RS-294, RS-329]
---

## Ask

> Create new workers.
> /Users/jinhu/Projects/recycle_servers_v2/recycle_servres_erp-seal/.orca/drops/data.csv
> I justed add a few new IP proxy. So pls create new worker for me.

> pls check the existing IPs and proxy.
> Add new worker based on the new proxy.

(The CSV lists Decodo ports 10001–10020 with the shared user and password. It
is left out here because it carries the live password; it is gitignored at
`.orca/drops/data.csv` and its ports match the VM's
`configs/proxies.decodo.txt`.)

## Context

The VM's `configs/secrets.env` names ten Decodo ports, 10001–10010, and each
one has a worker. wc-1 took 10009 after va-1 was locked (RS-294). The CSV adds
ports 10011–10020 on the same user and password. On 2026-10-20 all twenty
answered through `ip.decodo.com/json` and ipinfo with twenty different IPs, so
no new port shares an exit with a live worker:

| Port | Exit IP | Exit (ipinfo) | ASN |
| --- | --- | --- | --- |
| 10011 | 172.252.99.178 | Boston, MA | 6079 RCN |
| 10012 | 216.133.169.150 | New York, NY | 6079 RCN |
| 10013 | 9.142.77.158 | New York, NY | 6079 RCN |
| 10014 | 138.226.192.110 | Palo Alto, CA | 33651 Comcast |
| 10015 | 135.132.73.70 | Palo Alto, CA | 33667 Comcast |
| 10016 | 135.132.73.204 | Palo Alto, CA | 33667 Comcast |
| 10017 | 138.226.194.155 | Palo Alto, CA | 33651 Comcast |
| 10018 | 138.226.5.43 | Parsippany, NJ | 33659 Comcast |
| 10019 | 170.100.200.120 | Parsippany, NJ | 33659 Comcast |
| 10020 | 138.226.4.234 | Parsippany, NJ | 33659 Comcast |

`rs-fleetd` does not run on the VM, so a worker is still one compose file
(`deploy/docker-compose.homelab-*.yml`) plus its console entries, as in
RS-275. `scripts/deploy.sh` finds the compose files by glob and recreates
every one of them, so the existing ten must be held to stay untouched.

## Acceptance criteria

- [ ] Ten new compose workers run on the VM, one per new port, each with its
      own id, token, session dir, cache volume and VNC port (5912–5921):
      `bos-1` (10011), `nyc-2` (10012), `nyc-3` (10013), `ca-1`–`ca-4`
      (10014–10017), `nj-1`–`nj-3` (10018–10020).
- [ ] Each starts parked with an empty storage state and searches nothing
      until it has a login. Its seed city is the catalog city nearest its exit
      outside California: Boston, New York, Newark, or Reno for the Palo Alto
      exits.
- [ ] The console lists all ten in `RS_WORKER_CONFIGS` and `RS_VNC_TARGETS`,
      so the ERP's Fleet tab shows them, their cities can be edited, and Watch
      reaches their browsers.
- [ ] The ten existing worker containers are not recreated by the deploy.
- [ ] After the deploy each new worker heartbeats under its id.

## Out of scope

- Assigning Facebook accounts. That is done from the ERP's account pool, one
  account per worker, after its cities are set.
- California cities. `master.toml` keeps California out by owner decision
  (2026-08-25), so the Palo Alto workers do not seed a California city.
  Adding one is an ERP Edit cities change.
- Moving the workers under `rs-fleetd`.
- The stale `fleet.toml` slots and the README worker tables.

## Notes

- Ids are named after the exit, as in RS-275. The proxy is fixed and the cities
  are not. `ca-*` and `nj-*` follow `va-*`, which named the exit's state.
- Since RS-329 a listing alerts once across the fleet, so a city shared by two
  workers no longer means a second alert.
