---
id: RS-408
title: A DEGRADED heartbeat keeps renewing the task lease
type: task
status: done
priority: P2
created: 2026-10-26
reporter: jinhu
branch: fleet/fix-degraded-lease
pr: "#920"
version: 1.357.0
related: []
---

## Ask

> One more claim.ts finding to fix (from the scheduler review, its #7, left to you because claim.ts is yours): only a HEALTHY heartbeat extends the task lease, although the comment says DEGRADED keeps the task. A worker that turns DEGRADED mid-search loses its task at lease_minutes; reconcile expires it and a second account searches the same city, and the first worker's done is dropped. Fix: extend the task lease for any heartbeat state that is not parked, still capped by task_max_minutes; add a test (DEGRADED heartbeat during a lease keeps the task leased; parked releases it).

## Context

Fleet review follow-up to RS-406/RS-407 (parent RS-394).

## Acceptance criteria

- [x] A DEGRADED heartbeat during a lease renews it; a parked state releases it.
- [x] The renewed lease never runs past `leased_at + task_max_minutes`.

## Out of scope

—
