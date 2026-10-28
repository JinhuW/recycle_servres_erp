---
id: RS-439
title: Remove home cities from the ERP fleet
type: story
status: in-progress
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/bonito
pr:
version:
related: [RS-394]
---

## Ask

> Pls help me remove all concept of home of wokrer concept.
>
> clean up all related code.

(With a screenshot of Facebook fleet ▸ Cities, the "Home of" column boxed in red,
every cell "—".)

## Context

The ERP fleet (RS-394) let each slot carry an optional `home_cities` list
(`fleet_slots.home_cities`, migration 0206). It reached far: the slot claim
preferred slots whose home cities nobody else covered, the task pick ranked a
home city above a familiar one (`claim.ts` `taskRows`/`why()`), a quarantine
probe went to the first enabled home city (`scheduler.ts probeCity`), the
Add-to-fleet dialog had a home-cities picker, and the Cities, Tasks, Accounts,
Analysis and worker pages each showed who calls a city home. The dev catalog
of 2026-10-27 has 212 cities and no home cities, so all of it is dead weight.

Owner's scope, asked before planning: the ERP fleet only, and the history-based
"familiar" tier stays.

## Acceptance criteria

- [ ] Cities tab has no "Home of" column.
- [ ] Add to fleet (Proxies) has no home-cities picker; `POST /api/fleet/slots` refuses `home_cities` as an unknown field.
- [ ] Slot claim order: own worker, last host, account no — no home term; the claim answer has no `home_cities`.
- [ ] Task pick order: priority, familiar, due; `why` is `familiar | other | manual | probe`.
- [ ] Quarantine probe city: the most overdue enabled search city, else the first enabled city.
- [ ] Worker page: city chips are the cities it searched; no home group or note; Search now preselects the first.
- [ ] The Tasks city log, the Accounts "home city" tag on ERP rows and the Analysis home-worker column are gone.
- [ ] `FleetSlot`, `FleetSlotWrite`, `ClaimAnswer` and `FleetWorkerDetail.cities` carry no `home*`; unused i18n keys are removed (en + zh).
- [ ] `docs/FEATURES.md` and `docs/DATABASE.md` updated.

## Out of scope

- The legacy Python coordinator fleet's home cities (coordinator pages,
  `FleetWorkers.tsx`, `FleetCityLog.tsx`, coordinator rows' `now.home`):
  changing it needs a worker redeploy, which logs every account in.
- `trackers/facebook/rs_worker/entry.py` still reads
  `answer.get("home_cities") or []`. It already handles absence; editing it
  means a worker image release and recreated containers. Clean it with the next
  worker release.
- The "familiar" tier and the `familiar_days` rule stay.
- Dropping the `fleet_slots.home_cities` column. A drop in this release lets
  the old backend instance 500 on claim during Railway's overlap, and a failed
  claim makes the host agent start a fresh container, which is a Facebook
  login. It goes in a follow-up migration once this version is on prod.

## Notes

- Old `fleet_task_events.detail.why = 'home'` rows stay in the history; the
  worker page shows `why` as the stored string, so they still render.
