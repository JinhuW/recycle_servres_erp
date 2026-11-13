---
id: RS-586
title: Drop the retired seller columns and tables
type: task
status: backlog
priority: P2
created: 2026-11-13
reporter: jinhu
branch: fix/dev-release-review
pr:
version:
related: [RS-581, RS-585]
---

## Ask

> yes. Fix all remain.

(Follow-up of RS-585: the contract half of 0239.)

## Context

RS-585 left `fleet_slots.role`, `agent_on`, `agent_profile_id`,
`fleet_tasks.payload` and the seller tables (`fb_agent_profiles`, `fb_ads`,
`fb_threads`, … as listed in the first 0239) in production, because the release
before v1.457.1 still reads them while migrations run and after a rollback.

## Acceptance criteria

- [ ] Once v1.457.1 or later is on `main` and no rollback past it is planned, a
  new migration drops them with `IF EXISTS` (dev already dropped them).

## Out of scope

—
