---
id: RS-298
title: Fleet status column shows the last heartbeat time
type: task
status: done
priority: P2
created: 2026-10-18
reporter: jinhu
branch: feat/status-heartbeat-time
pr: 740
version: 1.283.1
related: []
---

## Ask

> just want to clarify:
> [Image #1]
> This status comes from the heatbeat, so pls add the last heatbeat time on  it and deploy to dev

(The screenshot outlined the Status column of Monitors ▸ Facebook ▸ Fleet.)

## Context

A worker's Live / Stale / Offline status is judged from the age of its last
heartbeat, but the table only showed that age as a hover tooltip on the Today
cell, so the status read as if it came from nowhere.

## Acceptance criteria

- [x] Each fleet row's Status cell shows "heartbeat {age}" under the chip
  (and its note), with the exact local time on hover.
- [x] A silent (offline) worker shows no extra line — its "Silent since"
  note already dates the beat.
- [x] A worker that has never heartbeated, or is not deployed, shows no line.

## Out of scope

—
