---
id: RS-529
title: "Fleet agent: licence outage exit"
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/quahog
pr: 1090
version: 1.420.0
related: []
---

## Ask

> Deep review the all feature of these https://cloakbrowser.dev/ and see how we can integrate with my current automation system and see how it can integrate with my proxy service.
>
> Long term goal, It will auto simulate the browser profile for each account.
>
> Create an detailed launch plan for it.

## Context

This implements workstream D of
[the CloakBrowser launch plan](../superpowers/plans/2026-11-04-cloakbrowser-launch-plan.md)
(see its "Licence outage design"). A cloak worker can't start when the browser's
licence server is out of reach. Exit 78 means "left for an operator", which is
too strong for an outage that clears by itself, and any undefined exit counts as
a crash and is held after 5 restarts in 30 minutes. Worker 0.17.0 (workstream E)
will exit 74 for this, so the agent needs its own rule first.

## Acceptance criteria

- [x] Exit 74 doesn't count toward `CRASH_LIMIT` or the 75/70 soft count.
- [x] Backoff is 5, 10, 20, 40, 60, 60, 60, 60 min, each plus up to 25% jitter.
- [x] After 8 attempts a further 74 is held as `license_outage`, reported like
      the other holds and left stopped until a person acts.
- [x] A run longer than 60 min clears the count, seen running or after it exited.
- [x] An agent restart keeps the count, the current wait's jitter and the hold.
- [x] Several workers in an outage start one per tick, a stagger apart.
- [x] A spent claim ticket or handoff reservation is recreated online, as for 75,
      and waits offline.
- [x] The report keeps `hold` and `outage_attempts`, and a roll skips the held
      worker.

## Out of scope

Emitting 74 from the worker (workstream E, `trackers/`). Swapping the agent on
any host, which needs the owner's yes. Any ERP UI for the new hold.

## Notes

- **Rollout:** the agent must reach hosts before worker 0.17.0. An older agent
  reads 74 as a crash and holds the worker after 5 restarts.
- Jitter is drawn once per wait and stored. Drawn per tick, the shortest draw
  would soon win and the delay would collapse to its base.
- Jitter applies above the 60 min cap, so a wait can reach 75 min. The capped
  retries are the ones a long outage lines up, so they need it most.
- A `replace` counts its attempt once the old container is gone, not at the
  start's stamp. If the ticket is refused, the later run looks like a plain
  missing worker and would otherwise never be counted.
- Bringing a held worker back (`docker rm` or `docker start`) clears the count.
  Otherwise its first 74 would be held again at once.
- The attempt count isn't cleared when a worker's container disappears without
  a hold, because a refused ticket looks the same.
- `state.ts` needed the new memory field and had to accept the new held reason:
  its loader drops any reason it doesn't know, which would have lost the hold on
  an agent restart. The backend report route keeps only named fields, so
  `outage_attempts` had to be added there too. It doesn't check `hold` against a
  list, so the new value needed no route change.
