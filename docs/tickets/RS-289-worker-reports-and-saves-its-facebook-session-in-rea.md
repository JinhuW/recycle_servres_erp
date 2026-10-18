---
id: RS-289
title: Worker reports and saves its Facebook session in real time, not at the next sweep
type: bug
status: in-progress
priority: P1
created: 2026-10-17
reporter: jinhu
branch: fix/worker-session-realtime
pr:
version:
related: [RS-279]
---

## Ask

> debug the issue that i already login in and pass the login successfully.
>
> But the status still does not update

(With a screenshot of va-2's row on the fleet page: "Needs attention · Session
expired" after the login had been finished over Watch.)

> help me update the backend to support real time data update instead of waiting for a sweep.

> make sure keep the seesion and never loose them.

## Context

On 2026-10-17 va-2's Re-login typed the vault password at 20:37 UTC, and the
operator finished the login over Watch after the 2-minute window had closed.
The browser was logged in, but the worker (facebook-tracker 0.10.0, vendored
monitor `3d6dc96`) only adopts a by-hand login when the page was *parked*,
and a password login that timed out did not park. So the heartbeat repeater
kept restating `SESSION_EXPIRED` and `fb_state.json` stayed an empty jar
(`{"cookies": [], "origins": []}`) until the next sweep, 13 hours away. A
restart in between would have thrown the login away.

facebook-tracker 0.10.1 (vendored `8958d2c`) closed two of the holes: a
password login that does not take now parks, and a successful Re-login reports
HEALTHY. Still open:

- The worker learns about its session only at a sweep, at a login, or on a
  parked page. A browser that becomes logged in any other way, or a session
  that lapses between sweeps, is reported up to a day late.
- The session file is written only at a sweep or a login. Facebook rotates
  cookies continuously, so the file falls behind the browser between sweeps.
- SIGTERM (`docker stop`, a redeploy) kills the monitor without saving, so
  whatever the live browser holds beyond the file is lost.

The ERP side is already near real time: the fleet pages poll every 30 s and
the coordinator stores each heartbeat as it lands.

## Acceptance criteria

- [ ] Between sweeps, a worker whose browser becomes logged in, parked or
      not, saves the session, backs it up to the coordinator and reports
      HEALTHY within about a minute.
- [ ] Between sweeps, a worker that reported HEALTHY and whose session lapses
      reports SESSION_EXPIRED within about a minute, without navigating the
      page.
- [ ] While logged in and idle, the worker re-saves and backs up the session
      at least every 30 minutes.
- [ ] On SIGTERM the monitor saves the live session before it exits. It still
      never overwrites a good file with a logged-out jar.
- [ ] The vendored monitor's suite passes; the pin in `VENDOR.md` and the
      facebook-tracker release carry the change.

## Out of scope

- ERP UI and backend changes. The fleet pages already poll every 30 s.
- Push delivery (SSE or websockets) from the coordinator to the ERP. With the
  worker reporting within a minute, a 30 s poll is not the bottleneck.
- Recovering the login va-2 held on 2026-10-17. The running process predates
  this fix and must not be restarted until its next sweep saves the session.

## Notes

- A host-side edit of a single-file bind mount does not wake the monitor's
  config watch, because inotify reports it on the host's `configs/`
  directory, not the container's. This also means the web UI's "restart
  monitor" button does nothing on the homelab workers. See the debug note.
