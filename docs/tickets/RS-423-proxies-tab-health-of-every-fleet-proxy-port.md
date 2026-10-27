---
id: RS-423
title: Proxies tab: health of every fleet proxy port
type: story
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/milkfish
pr: 949
version: 1.368.0
related: [RS-365, RS-415]
---

## Ask

> create a new dedicated tab in the facebook for tracking the health of the proxy ports.

Asked which proxies and how to measure:

> All Proxy we are using

> Backend probe + history (Recommended)

## Context

The Facebook fleet browses through two sets of proxy ports. The ERP fleet keeps
its own list (`fleet_proxies`, edited in Account pool ▸ Proxies since v1.364.0,
RS-415; `apps/backend/src/fleet/proxies.ts`). The legacy homelab coordinator's
workers dial ports named by env vars on the homelab, and rs_console looks up
each one's exit IP through the proxy itself
(`trackers/facebook/rs_console/rs_console/proxy_exit.py`, cached 6 h, 5 min
after a failure).

Health signals today are scattered: the legacy Fleet table's Proxy column
shows the exit IP or "lookup failed", and since v1.319.0 (RS-365) a proxy that
has burned more than four accounts is DEAD. Nothing says whether a port is up
right now, how slow it is, or whether it dropped overnight.

## Acceptance criteria

- [x] Monitors ▸ Facebook has a **Proxies** tab (`/#/fleet/proxies`, managers
  only) after Analysis, with a chip counting the proxies that are down.
- [x] It lists every ERP fleet proxy and every port a homelab coordinator
  worker dials, one row per exit `scheme://host:port`; a worker on the VM's
  own IP adds no row.
- [x] Each row: label (or the homelab workers on it), host:port, source (ERP /
  homelab), state chip **Up / Degraded / Down / Unchecked** (degraded: slower than 3 s, or one missed check; down: two misses in a row), the last latency, exit
  IP with city, region and ISP, a warning when the exit IP changed, 24 h uptime
  with a strip of half-hour buckets, when it was last checked, who uses it, and
  the existing DEAD / n failed mark.
- [x] The backend probes each ERP proxy every 5 min through the proxy itself
  (http, https and socks5) and records reachability, latency, exit IP and geo,
  or the error. Homelab ports are probed by rs_console through a new
  `/v1/proxies/health`, which the backend calls on the same round.
- [x] **Check now** probes one row, or all of them, and the row updates.
- [x] Checks are kept 14 days. Two backend instances never run the same round.
- [x] No proxy login reaches the browser, the logs or the check table.

## Out of scope

- Telegram alerts for a down proxy.
- Parking workers behind a down proxy automatically.
- Probing from each worker host. ERP proxies are probed from Railway, homelab
  ports from the homelab console, which is where those workers dial them.
- Vendor bandwidth or quota.

## Notes

Plan: `~/.claude/plans/shimmying-questing-sphinx.md` (session plan, not in the
repo). The tracker side ships first and stays optional: against a console
without `/v1/proxies/health` the tab shows the ERP's proxies alone.
