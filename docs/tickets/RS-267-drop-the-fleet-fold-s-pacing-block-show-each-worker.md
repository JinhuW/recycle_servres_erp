---
id: RS-267
title: Drop the fleet fold's Pacing block, show each worker's build in its subtitle
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-row-version
pr: 680
version: 1.268.0
related: []
---

## Ask

> This Pacing section is same for all workers. pls remove it.
>
> also add a worker version information in the subtitle of the workers.

(Two screenshots: the expanded denver-1 fold with its PACING block outlined,
and the sc-1 subtitle "sc-1 · South Central" with the space after it outlined.)

## Context

The fold under each row of the Fleet table (`FleetWorkers.tsx`) showed the
worker's cities beside a Pacing block: search interval, proxy, the daily plan
arithmetic and a hint about the eye. Every worker runs the fleet default, so
the block repeated the same line on every row. Pacing, proxy and build stay on
the worker's own page (`FleetWorker.tsx`). The build each worker reports
(`health.version`, e.g. "0.5.6 (d3e9a30)") was only visible there.

## Acceptance criteria

- [x] The row fold shows only the worker's cities; no Pacing block.
- [x] The row subtitle reads "worker id · region · v0.5.6", with the full
      build string (commit included) as its tooltip.
- [x] No version is shown for a worker that has not reported one or runs an
      unstamped image.

## Out of scope

- Colouring the subtitle version when it differs from the coordinator's
  build: the worker page's Build chip already does that.

## Notes

The strings only the Pacing block used (plan arithmetic, "via $env", the eye
hint) are removed; the worker page keeps its own pacing strings.
