---
id: RS-429
title: Proxies tab 500s on prod: fleet_proxy_rounds has no row
type: bug
status: done
priority: P1
created: 2026-10-27
reporter: jinhu
branch: JinhuW/merrow-3
pr:
version: 1.370.3
related: []
---

## Ask

> [screenshot: Monitors / Facebook → Facebook fleet → Proxies tab, "This backend has no fleet routes yet. The tabs fill in once the fleet release is deployed."]
>
> deploy this pls

## Context

Prod already ran v1.369.0, the fleet release. The card is what the Proxies tab
shows when `GET /api/fleet/proxies/health` fails, and on prod every call
returned 500 with `TypeError: Cannot read properties of undefined (reading
'now')` at `proxyHealthView` (`src/fleet/proxyHealth.ts`). `fleet_proxy_rounds`
holds one row, which migration 0215 inserts. On prod it was empty, most likely
because the RS-427 copy of dev's `fleet_*` tables into prod left it that way. With no row, the view crashed, and
`runProxyRound`'s claim (`UPDATE … WHERE started_at <= …`) matched nothing, so
prod never checked a proxy.

## Acceptance criteria

- [x] `GET /api/fleet/proxies/health` answers 200 with every proxy unchecked when `fleet_proxy_rounds` is empty.
- [x] A round recreates the missing row and runs.
- [ ] Prod's Proxies tab loads after the release.

## Out of scope

Reworking the RS-427 table copy. It was a one-off and has already run.
