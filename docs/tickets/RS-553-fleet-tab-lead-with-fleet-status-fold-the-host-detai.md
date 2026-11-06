---
id: RS-553
title: Fleet tab: lead with fleet status, fold the host detail away
type: story
status: done
priority: P2
created: 2026-11-06
reporter: jinhu
branch: JinhuW/trumpetfish
pr: 1120
version: 1.429.0
related: []
---

## Ask

> The current fleet page is in a mass. The host information cover the half page and it is hard to have a stright way to see the status of fleets.

## Context

`FleetAccountsTab` opened with a lede, `HostStrip` cards, `FleetAlerts`, `EngineCard` and `ReleaseBanner` above the workers table, so the table started about 1,500 px down and nothing stated the fleet's health. Digest-pinned images ran out of the host cards because `imageVersion` returned the whole string for any image with a digest.

## Acceptance criteria

- [x] A headline states healthy workers of total, and how many items need a person
- [x] Each host is one row with one bay per slot, coloured and shaped by state
- [x] Clicking a worker's bay filters the table to it
- [x] The state filter sits in the status panel and also keys the bay colours
- [x] Authoritative switch, capacity and remove live in a per-host fold; dialogs are unchanged
- [x] Alerts are one line each with their text on demand; a failed release's message stays visible
- [x] Engine loss rates stay visible; its controls live in a fold
- [x] Digest-pinned images read as their version; no text overflows a row
- [x] Mirror mode stays read-only
- [x] At 1200 px wide the workers table starts in the first screen

## Out of scope

Table columns, the default Healthy filter, the other Fleet tabs, the mobile shell, any API change.

## Notes

Plan and design mock: `http://10.10.100.225:8800/fleet-rack-mock.html`. `hostBays` went in `fleetRows.ts` rather than `fleetBoard.ts`, since it reads rows. The headline waits for the coordinator's first answer, because its workers would otherwise move the count. Checked in a browser against stubbed APIs, so no real worker, session or login was touched.
