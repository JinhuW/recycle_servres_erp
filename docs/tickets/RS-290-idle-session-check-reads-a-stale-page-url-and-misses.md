---
id: RS-290
title: Idle session check reads a stale page URL and misses a login finished over Watch
type: bug
status: backlog
priority: P1
created: 2026-10-18
reporter: jinhu
branch: fix/login-check-stale-url
pr:
version:
related: [RS-289]
---

## Ask

> I just relogined
>
> But the session information is still not available

> i just logined again for this worker.

(Each with a screenshot of va-1's fleet row reading "Needs attention · Session
expired", the second on v0.10.3, after the login had been finished over
Watch.)

## Context

RS-289 (facebook-tracker 0.10.3) made the idle worker check its browser's login
every minute. On va-1 on 2026-10-18 it never saw a login the operator finished
over Watch, on 0.10.1 or on 0.10.3: the browser was on Marketplace as the
account's user, and the session file stayed an empty jar.

`is_logged_in()` checked `page.url` for interstitial markers before it asked
for the cookies. Playwright's sync API refreshes `page.url` only while a call is
in flight. Between sweeps the idle check makes no other call, so it kept seeing
the `two_step_verification` URL the password login stopped on, returned False
before the cookie call, and so never refreshed the URL. Confirmed against real
Playwright: after an idle navigation, `page.url` holds the old URL until any
call (here `context.cookies()`) runs.

## Acceptance criteria

- [x] `is_logged_in()` asks for the cookies before it reads `page.url`, and a
      test covers a URL that changes only once the browser has been asked.
- [ ] On the live fleet, a login finished over Watch on an idle worker reads
      Healthy on the ERP within about a minute, with the session saved.

## Out of scope

- Recovering the login va-1 held when this was found. It lived only in the old
  process's memory.
