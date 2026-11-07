---
id: RS-560
title: Redeploys cause the fleet's 502s and 503s
type: bug
status: done
priority: P2
created: 2026-11-06
reporter: jinhu
branch: JinhuW/greenling-redeploy-errors
pr: 1133
version: 1.433.3
related: []
---

## Ask

> How is the progress of the error code review in the railway? Pls check all of error code and create a fix for them.

## Context

A review of every production backend deployment from 2026-10-29 to 2026-11-06
found 7,163 HTTP rows at 4xx/5xx. Railway's 7-day totals were 749,616 requests,
567 of them 5xx (0.08%). No route returned a 500 in the HTTP logs. Every 5xx
falls at a backend redeploy:

- **502 on `POST /api/fleet/worker/next-task` (23).** Nothing ended a held
  long-poll at SIGTERM, so `server.close()` waited for the 20 s grace, which cut
  the sockets. On 2026-11-06 SIGTERM came at 16:40:22.6 and the 502s at 16:40:42.
  A poll that woke after the pool closed explains the two `CONNECTION_ENDED`
  unhandled errors, each logged beside `shutdown deadline passed`.
- **503 on `GET /api/fleet/worker/vnc` (642).** The old instance releases the
  relay lock at SIGTERM and every worker dials back at once, but the new instance
  only tries the lock every 5 s, so dials in that gap were refused.

The `inbox poll failed` warning showed only ImapFlow's generic `Command failed`,
so the two failures on 2026-11-04 can't be explained after the fact.

## Acceptance criteria

- [x] SIGTERM releases every held `next-task` at once with a normal answer, and
  the server closes without waiting out the grace period.
- [x] A worker or viewer dial during the lock gap succeeds once the lock is taken.
- [x] A dial when no lock arrives still gets 503 after the wait; a bad token is
  refused without waiting.
- [x] An IMAP failure logs the server's response text.

## Out of scope

- `no_slot` and `stale_epoch` as 409 (1,767 rows): deployed workers read those
  codes, and changing them needs a worker release, which costs Facebook logins.
- `/api/auth/demo-accounts` 404 (37): deliberately invisible in production, and
  the login page reads it as "off".
- Bot scans on `/.env`, `/.git/config` and similar (3,408 403s, about 80 404s),
  and expired sessions (1,102 401s): already refused correctly.
- `PATCH /api/sell-orders/SO-4075` and `SO-4077` 400s (8): correct, other orders
  had sold those lots.
- 499s (68), 8 of which the app logged as truncated-body 422s at the same
  timestamps: slow requests that appear to be office uplink stalls. An inference,
  not proven, and it overlaps the performance evidence in RS-525.
- One other 422, `PUT /api/fleet/worker/session` on 2026-11-04 in 21 ms: the
  access log keeps `bad_request` but not its detail, so the cause is unknown.
- Lines Railway marks as errors but aren't: db-sync `drop cascades`, rclone
  `NOTICE`, Reddit `rate limited`, pgBackRest `stanza-create rc=50`
  (`pg_stat_archiver` shows archiving current, last failure 2026-10-23).

## Notes

Real server, one held poll, SIGTERM:

| | Drain | Held poll |
| --- | --- | --- |
| Before | 20.08 s | Socket cut at 23.1 s, no HTTP response |
| After | 0.07 s | 200 `nothing_due` at 3.06 s |

The relay wait is 6 s: past the 5 s retry, under the 10 s `open_timeout` in
`rs_worker/vnc_relay.py`. Dials authenticate before waiting, so unauthenticated
ones can't pile up. A bad token now gets its 401 during the gap instead of a 503.

Nothing here touches a worker, so it costs no Facebook login. The production
effect can only be measured on the first redeploy after this release, by
repeating the per-deployment log pull in the `railway-log-triage-recipe` note.
