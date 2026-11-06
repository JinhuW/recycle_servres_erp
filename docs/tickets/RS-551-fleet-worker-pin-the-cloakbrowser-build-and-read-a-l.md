---
id: RS-551
title: Fleet worker: pin the CloakBrowser build and read a live licence outage as an outage
type: bug
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/cloak-blockers-0-17
pr: 1115
version: facebook-tracker 0.17.0
related: []
---

## Ask

> 2. yes.

Answering: "Can I fix both blockers next? I'd treat a cloak browser's unexplained death as a possible outage, and retest it by checking the licence with a fresh launch. For the second, I'd pin the build to 155 and only move to 156 deliberately".

## Context

Spikes S1, S4 and S5 found two faults in the unreleased worker 0.17.0 code (results in
`trackers/facebook/docs/debug-notes/2026-11-02-cloakbrowser-fingerprint-probe.md`):

- A running cloak browser that loses the licence server dies as a bare `TargetClosedError`
  with no denial file, so the worker parked `browser_failed` and the outage handling never ran.
- The key now fetches build 156, which has no window frame and fails the preflight on every
  good profile. That failure also hid a moved exit.

## Acceptance criteria

- [x] A cloak browser dead with no reason given gets a fresh launch; an outage exits 74, anything else keeps today's park
- [x] Stock never launches a recheck
- [x] A worker image bakes the pinned build, and the build fails if it gets any other
- [x] On the real binary, with no account: preflight passes on a good profile, a wrong exit reads `exit_moved`, an outage on a running browser exits 74
- [x] Shipped in worker 0.17.0

## Out of scope

Moving to 156, fixing its window frame, and raising the agent's 15-minute recovery threshold.

## Notes

The recheck opens no page and carries no session, so it isn't a login. A free key ignores a pin, so baking with one fails the build, by design.
