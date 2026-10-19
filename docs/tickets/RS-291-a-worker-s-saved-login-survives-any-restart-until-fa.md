---
id: RS-291
title: A worker's saved login survives any restart until Facebook expires it
type: bug
status: backlog
priority: P1
created: 2026-10-18
reporter: jinhu
branch: fix/session-survives-restarts
pr:
version:
related: [RS-289, RS-290]
---

## Ask

> ultrathink now matter how we restart the VM. I hope we can keep the login information persist until expireed.

> is there anyway we can keep the session information in the DB, then we can reuse it?

## Context

A worker's Facebook login lives in its browser and in
`configs/sessions/<worker>/fb_state.json`, a host bind mount, so the file
outlives any container. Where a login has been lost, it was lost in the
gap between the browser and that file:

- Saved only at a sweep or a login, so a login finished over Watch lived in
  memory for hours (RS-289, fixed in 0.10.3; RS-290, fixed in 0.10.4).
- SIGTERM killed the worker without saving (fixed in 0.10.3).
- `docker stop` gives a container 10 s, and supervisord gives aimm 10 s, so a
  slow SIGTERM save could be cut short.
- The save renamed a file it had not fsynced, so a power cut right after a
  save could leave the name pointing at data that never reached the disk.

Audited and already safe: a boot with no network leaves the file alone (the
navigation fails and the next sweep retries), and a boot where Facebook rejects
the session leaves it alone too (`save_storage_state` refuses a logged-out
jar). The 31-byte files on nyc, phl, va-1 and va-2 are not lost sessions: those
workers were created on 2026-10-17 and have never held one.

## Acceptance criteria

- [x] Each save fsyncs the file and its directory before it trusts the rename.
- [x] Workers get 30 s to stop (`stop_grace_period`), and supervisord waits
      25 s for aimm's SIGTERM save (`stopwaitsecs`).
- [x] At login, a worker whose session file is missing or holds no session
      restores its own backup from the coordinator's database. A file that
      holds a session is never replaced.
- [x] The coordinator refuses a backup with no session in it, so a logged-out
      jar never replaces the snapshot a worker would restore from.
- [x] On the live fleet, a logged-in worker restarted with `docker restart`
      saves on the way out and comes back logged in, without a password login.

## Out of scope

- Raising dockerd's `shutdown-timeout` (default 15 s, which caps a VM reboot).
  It needs root and a Docker restart that would stop every container. The
  timed SIGTERM save decides whether it is worth doing.
- Restoring one worker's backup onto another worker or host. Facebook binds a
  session to its IP and fingerprint, so the coordinator releases a snapshot
  only to the worker that made it.
