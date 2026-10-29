---
id: RS-454
title: Fleet workers survive a slow page and can be marked healthy
type: bug
status: done
priority: P1
created: 2026-10-29
reporter: jinhu
branch: JinhuW/rs-454-fleet-mark-healthy
pr: 992
version: 1.380.0
related: []
---

## Ask

> These are not dead, But it shows dead.
>
> 1. Yes.
> 2. I can mark it as healthy.

(Reply to the diagnosis below: "1" approved fixing the monitor; "2" asked for a
manager action that marks a parked worker healthy, instead of a restart.)

## Context

On 2026-10-29 worker-60-14-3/-4/-5 (accounts 55, 14, 16) showed **Dead** on the
fleet page while heartbeating every 20 s. Prod `fleet_workers` had each one
reporting `DEAD`, `reason connect_failed`, `error "Page.goto: Timeout 60000ms
exceeded."`, `operator true`. They had searched normally until 10:59–11:17 UTC,
and their proxies (23, 27, 32) passed every five-minute ERP check all day.

In fleet mode the monitor's `Marketplace.goto_url` treats the first Playwright
`TimeoutError` as "Facebook or the proxy is out of reach" and parks for an
operator (`_fleet_park`), for good: no retry, `report_state` refuses anything
but DEAD, and the park loop reads no directive, not even Re-login. Only
`docker stop` ends it, and every new container is a login. One slow Facebook
page took a healthy account out for the day.

## Acceptance criteria

- [x] In fleet mode a navigation `TimeoutError` is retried in the same page (three attempts, 10 s then 30 s apart) before the worker parks; Chromium's proxy, tunnel and connection errors still park at once.
- [x] A worker parked with `connect_failed` takes a one-shot `resume` heartbeat directive: it clears the park, removes `RS_PARKED_FILE`, reports HEALTHY and goes back to `next-task`, with no new browser and no login.
- [x] `POST /api/fleet/workers/:id/resume` queues it like `/relogin`: refused unless the worker holds its live slot and reports DEAD with `connect_failed`; a second press while one waits returns the waiting one.
- [x] The heartbeat answer carries `resume` once (`resume_delivered_at`); a fresh claim clears it.
- [x] The fleet page row of such a worker says why it parked (the error on hover) and offers **Mark healthy**; so does the worker's watch page.
- [x] Monitor, backend and frontend tests cover the retry, the resume and the route's refusals.

## Out of scope

- A parked worker probing on its own and resuming without a manager.
- Mark healthy for `login_failed`, `browser_failed` or `crashed` parks: the browser is in an unknown or dead state there, so it would park again.
- Restarting the three workers that were parked on 2026-10-29. They run 0.14.10, which cannot take `resume`; the 0.15.0 rollout (one login per container) frees them and needs the owner's yes.

## Notes

- The monitor fix and the ERP side ship together; facebook-tracker 0.15.0
  must be rolled out (one boot login per replaced container, owner's call)
  before Mark healthy does anything on a live worker.
- Verified locally with two seeded workers parked DEAD `connect_failed`: the
  0.15.0 one queued a resume (`resume_requested_by` set, row "Mark healthy
  sent"); the 0.14.10 one's button was disabled with the version reason.
