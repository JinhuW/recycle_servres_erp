---
id: RS-514
title: Add to fleet avoids failed proxies
type: story
status: done
priority: P2
created: 2026-11-03
reporter: jinhu
branch: JinhuW/shad
pr: 1070
version: 1.413.0
related: []
---

## Ask

> when i add to fleet. it should avoid using failed proxy:

## Context

The Account pool's **Add to fleet** dialog
(`apps/frontend/src/pages/desktop/fleet/FleetProxies.tsx`, `AddToFleetDialog`)
chose its proxy with `proxyChoices` / `randomOpenProxy` (`fleet/proxyRules.ts`).
Both looked only at load against `max_accounts_per_proxy`, so a proxy failing
its health checks could still be chosen, either at random or by hand.
`POST /api/fleet/slots` (`apps/backend/src/fleet/workers.ts`) checked only that
the proxy existed and had room. The 5-minute proxy health round already records
every ERP proxy's checks in `fleet_proxy_checks`, and `proxyHealthState`
(`packages/shared/src/fleet.ts`) turns the last two into
`up | degraded | down | unchecked`. A new account's first sign-in through a dead
exit fails, and a failed sign-in is what gets accounts checkpointed.

## Acceptance criteria

- [x] The dialog loads proxy health. A `down` proxy is listed disabled, tagged "down".
- [x] The random pick never takes a `down` proxy. It takes an `up` one while any
      is, and otherwise any open one (`degraded` or `unchecked`).
- [x] When every proxy with room is down, the dialog says so and the confirm button is disabled.
- [x] If the health read fails, the dialog behaves as before: no proxy is treated as down.
- [x] `POST /api/fleet/slots` refuses a proxy whose last ERP checks read `down`
      with 409 `proxy_down` and a `detail`.
- [x] English and Chinese strings.

## Out of scope

- Moving accounts already on a proxy that later went down.
- How often the health round runs.
- `degraded` proxies (one miss after a pass, or slow) stay pickable by hand.

## Notes

- Down is two misses in a row, or a miss with nothing before it
  (`proxyHealthState`), so a single blip does not lock a proxy out.
- Verified locally: a seeded down proxy shows disabled with "down", a random
  add lands on the healthy one, and a direct API add to the down one gets 409.
