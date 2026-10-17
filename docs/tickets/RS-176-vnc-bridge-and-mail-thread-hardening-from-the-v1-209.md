---
id: RS-176
title: VNC bridge and mail thread hardening from the v1.209 review
type: task
status: done
priority: P3
created: 2026-10-04
reporter: Jinhu
branch: claude/project-thread-plu2yn
pr: 703
version: 1.275.1
related: [RS-175, RS-164, RS-161]
---

## Ask

> /code-review high all change from dev to main, and release to prod.

Asked which findings to fix before the release, Jinhu chose "Fix 1–4, then
release (Recommended)". Under that option, the six lower-priority findings
"get ticketed for later". This is that ticket.

## Context

The pre-release review of v1.204.0–v1.209.0 (RS-175) returned ten findings.
Four were fixed in RS-175. These six were not verified in depth. None is
reachable without a manager session or an unusual configuration, so they were
left out of the release. Line numbers are as of v1.209.0.

1. **Shutdown can hang on a dead viewer.** On SIGTERM,
   `closeVncBridges()` (`vncBridge.ts` ~L245) only starts a close handshake.
   Suppose a viewer's laptop sleeps and never answers. ws's 30-second close
   timeout outlasts the 25-second hard deadline, so `server.close()` keeps
   waiting, the deadline exits with code 1, and `closeDb()` is skipped. The fix
   is to `terminate()` after a short grace period.
2. **The `MAX_BRIDGES` cap can be exceeded.** The cap (~L226) is checked
   after the async `admit()`, but a socket only joins `open` inside the
   `handleUpgrade` callback. Concurrent handshakes all pass the check, so the
   slot should be reserved synchronously.
3. **Messages before the upstream opens are buffered without limit.**
   Client→worker chunks that arrive before the upstream socket opens are
   pushed onto `pending` (~L138) with no limit. That window can last up to
   20 s (ticket mint plus handshake). It needs a byte cap like `MAX_BUFFERED`.
4. **The attention reason can say "expiring" for a healthy session.**
   `attentionReason` (`lib/fleetView.ts` ~L145) returns `expiring` for any
   flagged worker with a non-null `session_days_left`. "Session expiring in
   40 days" is shown when the facade flagged the worker for something else.
   It needs a threshold, or the stale/unknown liveness cases should be checked
   first.
5. **IMAP never insists on STARTTLS off port 993.** IMAP
   (`mail/inbox.ts` ~L86) uses implicit TLS on 993 and never requires
   STARTTLS on any other port. SMTP, by contrast, sets `requireTLS` everywhere
   except 465. With `MAIL_IMAP_PORT=143`, a stripped STARTTLS sends the
   mailbox password in the clear. Set `doSTARTTLS: true` whenever the
   connection isn't implicit TLS.
6. **A redundant query on every thread poll.** `GET /:id/messages`
   (`routes/webSubmissions.ts` ~L438) runs `threadMessageIds` only to learn
   whether a sent or received message exists. `loadMessages` has already
   loaded those rows.

## Acceptance criteria

- [x] Shutdown terminates any bridge still open shortly after the close
      frame, well inside the hard deadline.
- [x] Concurrent upgrades cannot open more than `MAX_BRIDGES` sockets.
- [x] The pre-upstream client buffer has a byte cap and closes the socket
      when it is exceeded.
- [x] The "Needs a human" card never says "expiring" for a session with
      more than a threshold's worth of days left.
- [x] IMAP refuses to log in without TLS on a non-993 port.
- [ ] ~~`GET /api/web-submissions/:id/messages` derives `threaded` from the
      rows it already loaded.~~ Not done; see Resolution.

## Resolution

Verified against dev at v1.274.0 before fixing.

1. Fixed. `closeVncBridges()` terminates any bridge still open 2 s after the
   close frame (`TERMINATE_GRACE_MS`).
2. Not reachable. `attachVncBridge` passes no `verifyClient`, so ws 8's
   `handleUpgrade` completes and runs its callback synchronously; the size
   check and `open.add()` happen in the same tick and no handshake can slip
   between them.
3. Already fixed before this ticket (`MAX_PENDING_BYTES`, closes with 1009).
4. Fixed. `attentionReason` returns `expiring` only within
   `SESSION_WARN_DAYS` (7). The fleet table's note already applied that
   threshold itself, so nothing on screen changes; it now reads the reason.
5. Fixed. `doSTARTTLS` is set whenever the port isn't 993.
6. Left as is. `threadMessageIds` also requires a well-formed `message_id`,
   which `loadMessages` doesn't select, and the subject preview must follow the
   send path's rule exactly. Matching it would mean widening `loadMessages`
   for one small indexed query per poll.

## Out of scope

—
