---
id: RS-288
title: Console fleet dashboard shows the proxy URL, exit IP and city
type: story
status: backlog
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/console-proxy-exit
pr:
version:
related: [RS-281]
---

## Ask

> pls update the console

## Context

RS-281 (facebook-tracker 0.10.0) made rs_console's `/v1/fleet` return each
worker's `proxy` (credential-free URL plus exit IP, city, region, country,
org) and the ERP's worker page render it. The console's own dashboard
(`rs_console/static/fleet.js`) still showed only `$PROXY_…`, the env var name,
in the account table and in a worker's detail row.

## Acceptance criteria

- [ ] The account table's Proxy column shows the proxy host:port and, under it, the exit city (exit IP and org on hover).
- [ ] A worker's detail row shows the proxy URL and `IP · City, Region, Country`, or "looking up exit…" / "exit lookup failed".
- [ ] A worker with no proxy shows "own IP" with the VM's exit city.
- [ ] Search matches the proxy URL, exit IP and city.

## Out of scope

Any change to `/v1/fleet` itself; it already carries the data.
