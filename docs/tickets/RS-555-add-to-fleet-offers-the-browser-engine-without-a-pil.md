---
id: RS-555
title: Add to fleet offers the browser engine without a pilot
type: story
status: done
priority: P2
created: 2026-11-06
reporter: jinhu
branch: JinhuW/fleet-add-engine
pr: 1125
version: 1.431.0
related: []
---

## Ask

> How to add account to fleet and choose the new engine?

> How to enable the CloakBrowser by default

> yes. go ahead

> cloak_max_slots is 20 in my plan

> enable the cloak browser by default in all host

## Context

The Add to fleet dialog (`FleetProxies.tsx`) only showed an engine after a pilot was
named, so a normal add was always stock. `POST /api/fleet/slots` already takes
`engine` alone (`apps/backend/src/fleet/workers.ts`). An engine belongs to the
account rather than the host, so a default in this dialog, the only UI path that adds a slot, reaches
every host.

## Acceptance criteria

- [x] With no pilot named, the dialog shows a Browser choice with CloakBrowser selected.
- [x] CloakBrowser sends `engine: 'cloak'`; Stock Chromium sends no engine and adds as before.
- [x] A random proxy for a CloakBrowser or pilot add draws only an exit no other account is on.
- [x] With no such exit, the dialog says so and blocks the add until a proxy or Stock is chosen.
- [x] A named pilot still has to pick its arm by hand.

## Out of scope

Switching accounts already in the fleet: that is a device change and a login for
each. The launch plan's 1 in 5 stock holdout, and a fleet-wide default setting.

## Notes

The owner chose this over the launch plan's Phase 3 gate, which waits on a pilot.
At the time, 7 of 7 cloak accounts (#133 to #139) had reached a checkpoint within
45 minutes. `cloak_max_slots` was set to 20 on prod, the owner's licence seat count.
Explicit `engine: 'stock'` enrolls the account, refuses shared exits and pins the arm once
claimed, which is why stock sends nothing.
