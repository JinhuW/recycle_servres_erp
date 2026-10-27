---
id: RS-425
title: Proxies tab: list every proxy port, used or idle, once
type: bug
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/proxies-all-ports
pr: 950
version: 1.368.1
related: [RS-424]
---

## Ask

> i should have 20 proxy,But it only show 4

> yes. fix them.

## Context

The Proxies tab (RS-424, v1.368.0) on dev showed 4 rows: the ERP's
`fleet_proxies` (Decodo 10011, 10012, 10013, 10018). The homelab holds all 20
Decodo ISP ports, 10001–10020, as `PROXY_HOMELAB_*` vars in
`configs/secrets.env`, but:

- rs_console on the VM predates `/v1/proxies/health`, so the ERP's round
  records `coordinator = 'unsupported'` and shows no homelab row.
- Even deployed, the endpoint reported only ports a *live* worker dials. 34 of
  42 homelab workers are retired, so it would have reported 6 ports
  (10002, 10003, 10008, 10010, 10015, 10020), and 10 bought ports would never
  appear.

## Acceptance criteria

- [x] `/v1/proxies/health` reports every port in the workers' configs and in
      any `PROXY_*` var holding an http/https/socks5 URL, used or idle; an idle
      port has `workers: []`.
- [x] An idle port is dialed with the login of a worker on the same proxy
      host; two vars naming one port make one row and one dial.
- [x] The ERP shows a port on both its list and the homelab once, on the ERP
      row, with the homelab workers next to its accounts.
- [x] A row with neither accounts nor workers says "Nobody".
- [ ] After facebook-tracker 0.14.14 reaches the console, the tab lists 20
      rows.

## Out of scope

- A per-port label from the env var name (`HOMELAB_NYC2`); homelab rows stay
  `host:port`.
- Restarting or redeploying any worker: only the console container is rebuilt.

## Notes

Shipped through a console-only rebuild
(`docker compose -f deploy/docker-compose.console.yml up -d --build
--force-recreate console`), never `deploy.sh`, which restarts the workers and
so logs every Facebook account in.

Before the console went out, the homelab's console compose had already
dropped every legacy worker config (PR #951), so no worker lent a login and
every idle port would have read Down. A follow-up gives an idle port the
`<prefix>_USER` / `_PASS` pair its `PROXY_*` var's name starts with.
