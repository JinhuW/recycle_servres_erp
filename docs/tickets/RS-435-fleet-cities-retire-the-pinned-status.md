---
id: RS-435
title: Fleet cities: retire the Pinned status
type: task
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: rs-retire-city-pin
pr: 967
version: 1.372.0
related: []
---

## Ask

> move all pinnged cities to enabled. also remove pinned status.

## Context

The fleet Cities tab (`/#/fleet/cities`) listed 55 cities under **Pinned**
(`fleet_cities.pinned = true`, from migration `0206_fleet.sql`). The flag did
nothing: the scheduler (`apps/backend/src/fleet/scheduler.ts`) spaces a city's
searches by `COALESCE(per_day, settings.per_day_default)` and never read
`pinned`. It was reserved for WS-G tiers
(`docs/superpowers/plans/2026-10-24-erp-fleet/WS-G-tiers-second-host.md`), where
a pin would hold a city's tier, and tiers were never built. So a third of the
catalog sat in a bucket that meant nothing, and a star button toggled it.

## Acceptance criteria

- [x] A migration drops `fleet_cities.pinned`; every formerly pinned city is
      listed as Enabled, its `per_day` unchanged.
- [x] `GET /api/fleet/cities` no longer returns `pinned`; a `PUT` carrying
      `pinned` answers 422 unknown key.
- [x] The Cities tab legend has no Pinned segment, a row has no pin (star)
      button, and the lede has no pinned count.
- [x] Tests updated; backend and frontend suites pass.

## Out of scope

- The legacy coordinator's pins (`FleetCities.tsx`, `FleetAccounts.tsx`,
  `fleetView.ts` `pinEdits`): a different system, still read by the console.
- WS-G tiers. If they are built, pinning comes back as part of that design.

## Notes

- The 55 cities keep their 2× / 3× a day: the owner asked to move them to
  Enabled, not to change how often they are searched. Setting Per day to
  Default on a row is the way to bring one back to the fleet default.
