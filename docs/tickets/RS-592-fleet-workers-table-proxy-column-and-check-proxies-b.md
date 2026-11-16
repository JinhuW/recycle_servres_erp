---
id: RS-592
title: Fleet workers table: Proxy column and Check proxies button
type: story
status: done
priority: P3
created: 2026-11-15
reporter: jinhu
branch: feat/fleet-worker-proxy-column
pr: "#1213"
version: 1.463.0
related: []
---

## Ask

> also add an field for the proxy of these browser are using. also a fresresh buttom to let me check the health of them.

(Said over a screenshot of Monitors ▸ Fleet's workers table.)

## Context

The workers table showed each worker's account, state and engine but not the
proxy its browser dials, so telling whether a quiet worker sat behind a dead
port meant going to the Proxies tab and matching accounts by hand. The
backend already keeps every proxy's last check (`GET /api/fleet/proxies/health`)
and runs a round on demand (`POST /api/fleet/proxies/health/check`).

## Acceptance criteria

- [x] The workers table has a Proxy column: the proxy's label (or host:port),
      its health chip (Up / Degraded / Down / Unchecked), and the last check's
      latency and exit IP, or its error when it failed.
- [x] An ERP worker's proxy is the one its account's slot is on; a homelab
      worker's is the port the coordinator's last round saw it dial.
- [x] A Check proxies button in the table's toolbar probes every proxy and
      refreshes the table. It is hidden on the read-only mirror.

## Out of scope

Sorting or searching by proxy; a per-row check (the Proxies tab has one).

## Notes

Frontend only: reuses the Proxies tab's endpoints, no backend or contract change.
