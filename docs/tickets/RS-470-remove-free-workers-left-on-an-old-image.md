---
id: RS-470
title: Remove Free workers left on an old image
type: story
status: done
priority: P3
created: 2026-10-30
reporter: jinhu
branch: ticket/fleet-remove-stale-free
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1013
version: 1.388.0
related: []
---

## Ask

> when worker is free if the version is older than the current latest version, It should kill automately.

(screenshot: Fleet tab, Free rows homelab-6…10 and worker-60-14-13 on 0.15.0
(3576db7), homelab-11 and homelab-13 on 0.14.10 (f4d4fdf), worker-60-14-2 on
0.14.7 (1efd1a4))

> Remove container + hide row (Recommended)

(answer to: "What should 'kill' do?")

## Context

A Free worker's account has left the fleet, so its host's `count`
(`workerCount` in `apps/backend/src/fleet/hosts.ts`) falls below the
worker's number. The fleet-agent's rule was "nothing is ever removed"
(`apps/fleet-agent/src/plan.ts`), so the exited container stayed on the
host forever. A release skips it ("container exited"). Its Fleet tab row
keeps showing the build it last reported.

The worker could never come back on that old build. When the count reaches
it again, an online agent recreates an exited container on `desired.image`.
So the old container was only clutter on the host, and the row was clutter
on the tab.

## Acceptance criteria

- [x] An online, authoritative agent removes (`docker rm`) a worker container
  numbered above `count` when it is stopped, has no hold, is not awaiting a
  replacement run, and has an image other than `desired.image`.
- [x] It never removes a running container, a held one (exit 78, crash limit,
  stopped by hand), one within `count`, or anything while offline, while
  observe-only, or while `desired.image` is not allowed on the host.
- [x] A removal is not a start. It does not take the tick's start or move the
  stagger.
- [x] The Fleet tab leaves out a Free row whose container is not on its host's
  last report. The All and Free counts and the foot leave it out too. A Free
  row whose container is still there shows as before.

## Out of scope

- Deleting `fleet_workers` rows. They are history (as in RS-468).
- Stopping a running worker on an old image. A release does that.
- Comparing versions. The agent knows image refs only, so the test is "not
  the image new workers start on". After a failed release, the fallback image
  counts as current.

## Notes

The removal happens only once each host's agent runs the new agent image.
Swapping an agent is not a Facebook login and touches no worker container,
but it needs the owner's go.
