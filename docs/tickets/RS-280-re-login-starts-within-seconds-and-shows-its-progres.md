---
id: RS-280
title: Re-login starts within seconds and shows its progress on Watch
type: story
status: in-progress
priority: P2
created: 2026-10-17
reporter: jinhu
branch: fix/fleet-watch-relogin
pr:
version: 1.277.0
related: []
---

## Ask

> I tried to click the re-login.
> [screenshot of Watch on a worker parked at Facebook's login page]
> but nonthing happen

> i see. it just not opertae in the vnc. how can i allow me to see how it opertae in the vnc?

> yes. think of how to check the realtime opertaion and reduce the latency

## Context

On va-2, 2026-10-17, the click reached the console at 20:32:48 UTC
(`POST /api/coordinator/workers/va-2/relogin` → 200). The worker started at
20:37:23, typed the pool account's credentials, and stopped on a Facebook
captcha on `two_step_verification`. Anyone who left Watch before then saw
nothing.

The wait is entirely in delivery. The coordinator hands out the `relogin`
directive only in a heartbeat response (`take_relogin` in
`rs_coordinator/routers/health.py`), and the worker's repeater heartbeats every
300 s (`heartbeat_interval` in the vendored monitor's `facebook.py`). Once the
flag is set, the idle loop already wakes within a second. The ERP, for its
part, has no field that says a re-login is queued, under way, or waiting on a
human, so the button flashes "Re-login queued" for four seconds and goes
quiet.

## Acceptance criteria

- [ ] An idle worker starts a queued re-login within about 10 s of the click.
      It collects directives on a short poll (`POST /v1/workers/{id}/directives`)
      as well as on the heartbeat.
- [x] Against a coordinator without the poll route, the worker backs off and
      still gets its re-login through the heartbeat.
- [x] The worker reports each re-login step (`login_step`, `login_step_at`) by
      heartbeat. The coordinator stores them and exposes them, with
      `relogin_requested_at`, on its worker rows, and `/v1/fleet` carries them
      to the ERP.
- [x] While a re-login is in flight, the Watch page shows a strip that moves
      through queued, signing in, needs you (captcha or code, with a Take
      control button), and signed in or failed. It re-reads the fleet every
      3 s until the re-login settles.
- [x] From the worker page, the Re-login dialog offers "Re-login & watch",
      which queues the re-login and opens Watch.
- [x] The dialog and hint copy say "about 10 seconds", not "about 5 minutes".
- [x] Against a coordinator without the new fields, Watch behaves as before.

## Out of scope

- Push channels (SSE or websockets) from the coordinator to the worker or the
  ERP. Polling at these rates is cheap and needs nothing new to run.
- Interrupting a sweep already in progress. A re-login asked for mid-sweep
  still starts at the next item boundary, where `search()` checks the flag.
- Solving captchas automatically.

## Notes

- Plan: `~/.claude/plans/tender-munching-wilkes.md` (session plan, not in the
  repo).
- The tracker side ships first and stays backward compatible: new fields are
  optional on both ends, and the new route is additive.
