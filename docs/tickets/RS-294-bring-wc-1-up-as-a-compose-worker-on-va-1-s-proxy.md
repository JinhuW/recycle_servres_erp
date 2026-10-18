---
id: RS-294
title: Bring wc-1 up as a compose worker on va-1's proxy
type: task
status: in-progress
priority: P1
created: 2026-10-18
reporter: jinhu
branch: fb-wc-1-worker
pr:
version:
related: [RS-275, RS-293]
---

## Ask

> There are two worker has down. pls make them up

(On a screenshot of Monitors ▸ Facebook: `se-1` Offline "Not deployed",
`cummingsa146966@hotmail.com` / `wc-1` Offline "Never reported".) After the
diagnosis, the requester chose:

> 1

That was "wc-1 as a compose worker now". They also picked "Take va-1's port
10009" for its proxy and "Duplicate west-1's cities" for its cities.

## Context

Neither row was a crashed worker:

- **se-1** is a `fleet.toml` name with no vault account and no container. Its
  28 southeast cities are searched by `homelab-1` (`rs-monitor`), which
  reports under its own id. There is nothing to start.
- **wc-1** has a vault account (assigned from the ERP pool) but no compose
  file, config or container. `rs-fleetd` is not running on the VM yet
  (`rsc fleet hosts` → no hosts), so nothing picked the slot up.

All ten Decodo ports had a worker. va-1 (port 10009) was locked by Facebook
on 2026-10-18 and its container is stopped, so wc-1 takes that port and va-1
is retired from compose. Otherwise the next deploy would recreate it on the
same IP.

## Acceptance criteria

- [ ] `deploy/docker-compose.homelab-wc.yml` runs `rs-monitor-wc` as
      `RS_WORKER_ID=wc-1` on `PROXY_HOMELAB_WC` (port 10009), with west-1's
      cities (`configs/homelab-wc.toml`, generated from `rs_west`).
- [ ] The console lists wc-1 in `RS_WORKER_CONFIGS` and `RS_VNC_TARGETS`, so
      the ERP shows its cities and Watch reaches its browser.
- [ ] va-1's compose file and console entries are gone, and no deploy
      restarts it.
- [ ] After deploy, wc-1 heartbeats and the ERP row is no longer "Never
      reported".

## Out of scope

- se-1: it has no account, and homelab-1 covers its region. Renaming the
  `fleet.toml` slot is left for later.
- Moving the workers under `rs-fleetd`.
- va-1's vault account. It stays as it is (locked).

## Notes

- Before the account signs in, its first login is an automated password login
  on an account with no device profile, which is the va-1 pattern. RS-293's
  cap (2 password releases per 24 h, stop on a lock) applies.
