---
id: RS-405
title: Fleet agent: fix the review findings (holds, stagger, handoff, identity, images)
type: bug
status: done
priority: P1
created: 2026-10-26
reporter: jinhu
branch: fleet/fix-agent
pr: 915
version: 1.352.0
related: [RS-394, RS-400]
---

## Ask

> Owner's go-ahead: fix every finding in your review (H1, H2's agent side, M1–M6, and the lows). Your read-only restriction is lifted for this.

(Relayed by the coordinator session after the read-only review of
`apps/fleet-agent/**` on `origin/dev` at v1.350.1.)

## Context

Every worker container start is a Facebook login. The review found paths in
the host agent that start workers more often than intended (a crash limit
that ages out, a stagger that a lost answer or a lost `/state` bypasses, a
`docker stop` the agent undoes, two agents for one host fencing each other's
live workers), a handoff record that could wedge a worker, reports that let
the ERP pick a held worker for a roll, and no check on which image runs.

## Acceptance criteria

- [x] H1: a worker past the crash limit stays held for that container after
      the window and across agent restarts; only counted crashes count.
- [x] H2 (agent half): held containers are reported with a distinct `state`
      and an optional `hold` (`operator_needed`, `crash_limit`,
      `operator_stopped`), plus `exit_code` and `image_id`.
- [x] M1: a start is written down before it is made and not made if it
      cannot be; the stagger counts from the newest container `StartedAt` too.
- [x] M2: the agent sends an instance id and daemon id on desired, report and
      stopped, and observes only while another agent for its host runs on
      the daemon.
- [x] M3: exit `0`/`143` while the agent ran, not caused by the agent, is
      held as `operator_stopped`.
- [x] M4: a spent confirmed stop never skips stopping an existing container.
- [x] M5: `FLEET_IMAGE_PREFIX` allowlist; `--` before the image.
- [x] M6 and the lows: tests for the window rollover, the failure paths, the
      wedge and the handoff cases; 401/403/404 → observe-only; repeated 75
      backs off; offline never `docker start`s a handoff container; a waiting
      reservation is released on observe-only; keepalive reports during long
      actions; tag refs re-pulled; interval floor; count cap; tolerant leases;
      notes logged once; observe retries a vanished container.

## Out of scope

Backend halves, owned by other sessions: excluding held/non-running
containers from roll candidates (`fleet/hosts.ts`), storing the new report
fields (the report route keeps four fields today), refusing a second agent
instance on `/stopped`, and a TTL for reservations lost with an agent's
`/state`. No agent container on a live host is replaced by this change.

## Notes

Review findings and the per-finding fix list are in the PR body.
