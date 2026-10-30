---
id: RS-463
title: Fleet hosts never remove a worker; drop the Removed status
type: story
status: done
priority: P2
created: 2026-10-29
reporter: jinhu
branch: JinhuW/amphipod
pr: 1004
version: 1.385.0
related: []
---

## Ask

> I don't need this "removed status", cuz i don't want this happen.

## Context

The Fleet table showed **Removed** (v1.381.0, RS-458) for a worker whose
container its host deleted. The host agent (`apps/fleet-agent/src/plan.ts`)
stopped and removed every container numbered above `desired.count` in one
tick. The count falls when a manager lowers capacity. It also falls on its
own: `workerCount` (`apps/backend/src/fleet/hosts.ts`) follows the claimable
slots, so retiring accounts lowered it and deleted the workers above it.
Each one thrown away was a signed-in browser, and bringing it back is a
Facebook login.

## Acceptance criteria

- [x] The agent never removes a worker. A running container beyond the count
      keeps running. An exited one is left stopped, with a note, and is not
      restarted while it stays beyond the count.
- [x] A release roll still replaces a running worker beyond the count when
      the ERP names it, so a release cannot stall on it.
- [x] When the count rises back over a stopped extra, the agent's existing
      path starts it again.
- [x] The Fleet table has no Removed kind or chip. A stopped worker with no
      slot reads Free; otherwise it reads Parked.
- [x] The lower-capacity confirmation says the workers above the new count
      keep running and are not started again once they stop. Nothing is
      removed.

## Out of scope

- Removing a host, which is unchanged.
- Cleaning up old stopped containers. A person can `docker rm` one, as
  before.

## Notes

Asked "What should happen instead of the Removed status?", the owner picked
"Stop hosts removing workers" over hiding the rows or reading them as Free.

The agent reaches a host only when its container is re-run with the new
image. Per the agent's README, that does not touch running workers. Until a
host's agent is swapped, that host keeps removing extras.
