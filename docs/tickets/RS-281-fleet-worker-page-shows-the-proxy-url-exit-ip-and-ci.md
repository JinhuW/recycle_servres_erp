---
id: RS-281
title: Fleet worker page shows the proxy URL, exit IP and city
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-proxy-exit
pr: 710
version: 1.278.0
related: []
---

## Ask

> 1. update page. to show the actual Porxy url / Ip / City of the proxy.

## Context

The ERP's Fleet ▸ worker page (`apps/frontend/src/pages/desktop/FleetWorker.tsx`)
showed the proxy only as the env var holding it (`$PROXY_HOMELAB_NE`). That
says nothing about where the account appears to Facebook, which is what
matters: fleet.toml's rule is to match the proxy's geography to the region.
rs_console already has every `PROXY_*` value in its environment
(`deploy/docker-compose.console.yml` loads `secrets.env`), so it can strip the
credentials from the URL and ask an IP-geo service *through* the proxy which
exit the worker actually gets.

This reverses one rs_console rule (`fleet.py`: "proxy URLs never leave
here"): the URL now leaves, with its credentials removed.

## Acceptance criteria

- [x] The worker page's Proxy row shows the proxy URL without credentials,
      the exit IP, and city / region / country (ISP org as a tooltip).
- [x] A worker with no proxy shows "none · own IP" plus the VM's own public
      IP and city.
- [x] Credentials (username, password, `user:pass@` in a URL) never appear in
      `/v1/fleet`.
- [x] A proxy whose lookup fails shows the URL and "exit lookup failed"; the
      page still renders.
- [x] Lookups are cached (6 h on success, 5 min on failure), so the page's
      30 s refresh does not hit the geo service.

## Out of scope

- Showing proxy credentials.
- Editing proxies from the ERP.
- A proxy column on the fleet list; the worker page only.

## Notes

- Plan: the exit is looked up by rs_console (`rs_console/proxy_exit.py`) via
  `https://ipinfo.io/json`, keyless. `proxy_env` stays in the document for
  ERP builds that predate `proxy`.
