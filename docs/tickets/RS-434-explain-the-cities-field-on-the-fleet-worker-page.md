---
id: RS-434
title: Explain the Cities field on the fleet worker page
type: story
status: done
priority: P3
created: 2026-10-27
reporter: jinhu
branch: JinhuW/fleet-cities-note
pr: 965
version: 1.371.3
related: []
---

## Ask

> pls add a for note the cties filed.

## Context

The ERP fleet worker page (`pages/desktop/fleet/FleetErpWorker.tsx`) has a
**Cities** row. The backend builds it in `apps/backend/src/fleet/workers.ts`
(worker detail): the slot's `home_cities`, highlighted, plus every city the
worker searched in the last `DETAIL_DAYS` (7) days, grey. On 2026-10-27 every
prod slot has `home_cities: []`, so the row shows only cities the queue
handed out — homelab-1 (#47) showed 14 from one day's run — and it read like
a list tied to the worker. The owner had just asked that no worker have
cities tied to it, and asked why this one did.

## Acceptance criteria

- [x] Under the Cities chips (and under "no cities"), a small muted note says
      they are the cities the queue handed this worker in the last 7 days, and
      none is tied to it.
- [x] When the slot has home cities, the note says the highlighted ones are its
      home cities.
- [x] English and Chinese strings; the day count comes from the API's
      `stats.days`.

## Out of scope

Renaming the row; the legacy homelab worker page (`FleetWorker.tsx`), whose
city lists were emptied on the VM the same day.
