---
id: RS-286
title: Park a Facebook worker whose login fails instead of searching logged out
type: bug
status: done
priority: P1
created: 2026-10-17
reporter: jinhu
branch: fix/monitor-park-gaps
pr: 714
version: facebook-tracker 0.10.1
related: [RS-275, RS-280]
---

## Ask

> Fix all bugs

(After RS-275's rollout report, which named the monitor gap for a worker with
no session file, and `homelab-1` / `ne-1` reading "Session expired".)

## Context

A worker that cannot log in is meant to *park*: keep its page on Facebook's
login or checkpoint screen, search nothing, and adopt a session an operator
finishes over Watch. The parked state is the session file's fingerprint
(`_session_blocked_on`, `facebook.py`). Two paths missed it:

- **No session file at all.** The fingerprint was `None`, which reads as
  "never parked", so the next job searched Marketplace logged out. All four
  RS-275 workers did this once on first start
  ([debug note](../debug-notes/2026-10-17-new-worker-without-session-file-searches-logged-out.md)).
- **A password login that stops on a checkpoint.** `login()` waited
  `login_wait_time` and returned normally, unparked. `va-2`, the first pool
  assignment, did this at 20:37 UTC on 2026-10-17: the checkpoint was cleared
  afterwards and the browser is logged in, but the worker never adopted it, so
  the session was not saved and the ERP read "Session expired". Its next job
  would have searched from whatever page it was on.

A Re-login that did work also left the dashboard on "Session expired" until
the next sweep's heartbeat, hours later.

`homelab-1` and `ne-1` are not code bugs: their session files date from
2026-09-10 and 2026-09-18 and lapsed at Facebook. Both are parked correctly and
need a login (a pool account, or by hand in Watch).

## Acceptance criteria

- [x] A worker with no session file parks after its failed login and searches
      nothing until a session file lands or a Re-login runs.
- [x] A password login that does not end logged in parks the page, reports
      `SESSION_EXPIRED` ("password login did not complete") and does not
      overwrite the saved session.
- [x] A checkpoint finished by hand on that parked page is adopted by the idle
      loop: the session is saved and the worker reports healthy.
- [x] A Re-login that works reports `HEALTHY` straight away.
- [x] The new workers' compose headers no longer require an empty session
      file before first start.

## Out of scope

- Logging `homelab-1` and `ne-1` back in: that needs an account and a human,
  not code.
- Why `va-2`'s checkpoint raised no challenge record.

## Notes

- Vendored monitor commits on `recycle-patches`: "Park a worker that has no
  session file at all" and "Park after a password login that does not take",
  rebased on RS-280's `9350dd7`.
