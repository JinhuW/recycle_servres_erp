---
id: RS-298
title: Show last heartbeat time under the Fleet status chip
type: story
status: done
priority: P2
created: 2026-10-18
reporter: jinhu
branch: fleet-heartbeat-status-time
pr:
version: 1.284.0
related: []
---

## Ask

> also add an last heatbeat time for the status

(Sent with a screenshot of the Monitors ▸ Facebook ▸ Fleet workers table.)

## Context

The Fleet table (`apps/frontend/src/pages/desktop/FleetWorkers.tsx`,
`WorkerRow`) showed a status chip and, only for flagged workers, a reason
note. How recently a worker last reported was visible only as a tooltip on
the Today bar, or inside "Silent since …" for a dead worker.
`health.last_heartbeat_at` already arrives on every `FleetAccount`
(`lib/coordinator.ts`), so this is frontend-only.

## Acceptance criteria

- [x] Every Fleet row whose worker has a heartbeat shows "heartbeat 2m ago"
      under its status chip (below any existing reason note).
- [x] Hovering it shows the absolute local timestamp.
- [x] Silent rows don't repeat the age ("Silent since …" already says it);
      never-reported / not-deployed rows show their existing note only.

## Out of scope

The worker detail page (its header already shows the heartbeat age), the
Account pool table, and auto-ticking the relative time between refreshes.

## Notes

The Today cell's heartbeat tooltip was dropped as redundant. A parked
(checkpoint) worker that is also silent still gets the heartbeat line, since
its note is the checkpoint, not the silence.
