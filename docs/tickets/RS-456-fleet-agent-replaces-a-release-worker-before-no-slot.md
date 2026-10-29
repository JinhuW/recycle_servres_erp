---
id: RS-456
title: Fleet agent replaces a release worker before no-slot retries
type: bug
status: done
priority: P1
created: 2026-10-29
reporter: jinhu
branch: JinhuW/rs-456-agent-release-before-retries
pr:
version: 1.380.1
related: []
---

## Ask

> yes. go ahead to depoloy the new version

(Then, picking from the options given when the 0.15.0 release stalled:
"Fix agent, then re-release".)

## Context

On 2026-10-29 the facebook-tracker 0.15.0 release (RS-454) replaced
worker-60-14-1 and then stalled on homelab-1. The homelab host has capacity
14 but fewer claimable accounts, so homelab-3 and homelab-5 exit 75 ("no free
slot") every few minutes. `plan()` in `apps/fleet-agent/src/plan.ts` gives
the tick's one start to an exited worker's restart before the release's
deferred replacement, so those retries took every 3-minute start and the
replacement never ran. The ERP fails a release whose named worker is not back
on the new version within 40 minutes of being named.

## Acceptance criteria

- [x] While the release names a running worker on this host that is not on
  the desired image, an exit 75/70 restart waits and the replacement takes
  the start.
- [x] A crashed worker (any other exit code) and a missing worker still go
  first.
- [x] Once the named worker is on the image, 75/70 restarts go on as before.
- [x] Plan tests cover all three.

## Out of scope

Capping the host's worker count at its claimable accounts, so spare
containers stop retrying at all: a separate change to `desired.count`.
