---
id: RS-512
title: Fleet retries a connect_failed park by itself and says why it is parked
type: bug
status: done
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/frogfish-3
pr: 1064
version: 1.411.0
related: []
---

## Ask

> debug the issue that fleet does not, but the page say. it is dead.

> yes. go ahead and fix both of them.

## Context

homelab-2 (pool #11) showed "Dead" on its worker page while its heartbeat was
fresh, its session had 365 days left and the browser chip said "browser not
open". Prod's `fleet_workers` row and the worker log show it really was
parked: on 2026-11-01 04:27 UTC a DNS/network outage made every outbound call
fail (`Temporary failure in name resolution`), a listing's `Page.goto` timed
out after monitor 0.15.0's retries, and the worker parked DEAD with
`detail.reason = connect_failed` ("Parked for an operator"). worker-60-14-6 on
the other host parked in the same minute, and worker-60-14-3 at 13:18. The
network came back in minutes, but that park waits for a manager's **Mark
healthy** (`POST /api/fleet/workers/:id/resume`, RS-454), so all three sat idle
about 37 h until a manager pressed it on 2026-11-02 17:58 UTC.

Two gaps: nothing retries the park when the network returns, and the worker
page says a bare "Dead" with no reason, no age and no Mark healthy button.

## Acceptance criteria

- [x] A worker on a build that takes `resume` (>= 0.15.0), heartbeating DEAD
  `connect_failed` with no resume waiting, is sent `resume` by the ERP itself:
  10 min after it parked, then 30 min, then hourly, at most 8 times per park
  run. The request is recorded as `requested_by = 'auto'`.
- [x] The count starts again once the worker has stayed HEALTHY for an hour,
  and on a fresh claim; a park that keeps failing stops being retried and
  stays visible.
- [x] Builds before 0.15.0, other DEAD reasons and other parked states are
  never auto-resumed.
- [x] The worker row carries `state_since` (when the reported state last
  changed) and `auto_resumes`.
- [x] The ERP worker page reads "Parked: couldn't reach Facebook · since <age>"
  for a connect_failed park, says when the next automatic retry is due (or
  that it gave up), and offers Mark healthy.

## Out of scope

- A monitor-side retry loop (needs a worker image release, and every
  container recreate is a login).
- SESSION_EXPIRED / CHECKPOINT parks: those need a real login.

## Notes

Investigation page: http://10.10.100.225:8800/fleet-homelab-2-dead.html
