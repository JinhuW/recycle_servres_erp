---
id: RS-394
title: Facebook workers pull cities from an always-on fleet queue in the ERP
type: story
status: backlog
priority: P2
created: 2026-10-24
reporter: jinhu
branch: JinhuW/argonaut
pr:
version:
related: [RS-372, RS-379, RS-385, RS-393]
---

## Ask

> The current facebook worker is working based on schedule. Ultrathink if we can keep worker active, which means when the queue has task, then it will start to work. instead of waiting on certain timepoint to start the task.
>
>
> Maybe worth to introduce a message queue service as well?

Later the same day, in the same conversation:

> The long term goal is creating a dynamic cities list.

> I may add more cities in the queue and remove certain cities.

> So pls also avoid any local vm configuration and i can easily scale it.
> I am fine with share the account and password info.

> FYI, The worker may located in multiple hosts. Pls reevaluate the design

> Polish and come out with a executable implementation plan.
>
> It can be seperate with current service.

> I meant it shoudl still be part of the erp system.

> I meant not sure if python is the best language, i do prefer the ts node

> pls create an project folder with all deatiled implementation plan.
> I hope the implementation plan can be worked by multiple agents.
>
> The first host can run in the  ssh worker@10.10.60.14.

## Context

Workers sweep once a day at 13:00 UTC and stop at the first empty `next-city`
answer. At 11:15 UTC on 2026-10-24 all 127 cities were due and 15 healthy
workers were idle. Each worker is a compose file plus config, secrets and a
session on one homelab VM; every restart is a Facebook login (root
`AGENTS.md`, first rule).

The ERP already holds the account pool with sealed credentials
(`fb_pool_accounts`, `FB_POOL_KEY`). The design puts a Postgres task queue
and a slot-claim protocol into `apps/backend`, in TypeScript, with identical
worker containers on any host long-polling for their next city, and managers
editing the city list in the ERP. No message broker. The Python coordinator
keeps alerts.

Design: `docs/superpowers/specs/2026-10-24-erp-fleet-task-queue-design.md`.
Plan, split for several agents: `docs/superpowers/plans/2026-10-24-erp-fleet/`.

## Acceptance criteria

- [ ] WS-A: `0205_fleet.sql` applied; `/api/fleet` with manager, host and
      worker scopes; cities/items/settings routes; the scheduler keeps one
      open task per enabled city and item; import from `master.toml` yields
      254 ready tasks.
- [ ] WS-B: `claim`, `heartbeat`, `next-task` (long-poll, `SKIP LOCKED`,
      fenced epoch), `events`, `session`, host `desired`/`report`, releases;
      a scripted worker runs claim → poll → task → done → next task.
- [ ] WS-C: the worker image in fleet mode claims a slot, renders its config
      in-container, searches tasks from the long-poll, never falls back to an
      own list, exits 75 on a stale epoch; non-fleet mode unchanged.
- [ ] WS-D: `apps/fleet-agent` runs the desired count of workers on a host
      with two settings, staggers starts, rolls one worker at a time, is
      observe-only until authoritative.
- [x] WS-E / E2: approved Fleet, Tasks, Cities, Analysis and Account pool
      tabs; add/remove/pin/search-now a city; start the round; host capacity
      and tokens; merged account states; pipeline analysis. v1.344.0.
- [ ] WS-F: images on GHCR; first host `worker@10.10.60.14` registered; pilot
      of four accounts, then the whole fleet, each step with the owner's yes;
      the VM keeps no per-worker files.
- [ ] WS-G: tiers by alert hits; a second host shares the fleet.
- [ ] `docs/FEATURES.md` describes the fleet tabs with their versions;
      `docs/DATABASE.md` lists the fleet tables.

## Out of scope

- A message broker (Redis, RabbitMQ, NATS). Reasons in the spec.
- Moving listing dedupe, alerts, challenges or Messenger out of the Python
  coordinator (follow-up ticket after cutover).
- Automatic adding or retiring of cities; people edit the list.
- Mobile pages for the fleet tabs.

## Notes

- Preview pages (served from the office Mac):
  `http://10.10.100.225:8800/fleet-implementation-plan.html`,
  `http://10.10.100.225:8800/fleet-task-queue.html`,
  `http://10.10.100.225:8800/fleet-always-on.html`.
- A `/code-review high` of the RS-372 spec on 2026-10-24 found: unbounded
  lease renewal, quarantine with no exit, DEGRADED releasing a city
  mid-search, the held rule skipping home cities, and 4xx answers causing an
  own-list sweep. Each has a fix in the design (decision 11 in the plan).
- `10.10.60.14` was not reachable from the Mac mini on 2026-10-24 (timeout on
  22); verify from the owner's machine.

- WS-E2 rework: implemented at v1.344.0; review and screenshots are recorded
  in `docs/superpowers/plans/2026-10-24-erp-fleet/WS-E2-ui-rework.md`.
  The parent ticket remains open for cutover and WS-G.
