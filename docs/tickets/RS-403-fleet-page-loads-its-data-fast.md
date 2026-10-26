---
id: RS-403
title: Fleet page loads its data fast
type: story
status: in-progress
priority: P2
created: 2026-10-26
reporter: jinhu
branch: docs/fleet-speed-plan
pr:
version:
related: [RS-394]
---

## Ask

> btw. I noticed the Fleet page load is very slow. Think of a apporach to speed it up.

Later the same day:

> while you are on waiting. pls create an plan for speed up the fleet data loading in the erp system.
> Then fan out agents to implemnt it.

## Context

Monitors ▸ Facebook waits about 6 s before it shows anything. A read-only
measurement on 2026-10-26 found the Fleet tab puts six calls in one
`Promise.all`, and the slowest, `/api/coordinator/fleet` (the console's
`/v1/fleet`), took 5.0–5.9 s each time for 160 KB. The console builds that
document step by step, and its `/v1/accounts` does one remote-database
lookup per account (2.1 s). Nothing is cached, the page fetches the same
URLs several times, and it polls every 10 s, about 50 requests a minute per
viewer. Explainer: `http://10.10.100.225:8800/fleet-page-speed.html`.

Plan: `docs/superpowers/plans/2026-10-26-fleet-page-speed.md`.

## Acceptance criteria

- [ ] With a warm ERP cache, `/api/coordinator/fleet` answers in under 200 ms, and the console is called at most once per 15 s however many managers have the page open.
- [ ] The Fleet tab shows the ERP's own rows without waiting for the coordinator; coordinator rows fill in when they arrive.
- [ ] One Fleet tab load sends each distinct URL once.
- [ ] Coordinator data is polled every 30 s, never while the previous read is still in flight.
- [ ] The Fleet tab and the tab-bar counts read a pool summary that unseals no secret.
- [ ] The console's `/v1/fleet` and the coordinator's `/v1/accounts` are faster cold (code merged; deploying them to the homelab is a separate step with the owner's yes).

## Out of scope

- Deploying the console or coordinator change to the homelab VM (each recreate is an owner decision; workers are never restarted).
- Moving coordinator data into the ERP (that is the fleet cutover, RS-394).
- Mobile pages.

## Notes

- 2026-10-26: four workstreams fan out in parallel (plan § Workstreams).
