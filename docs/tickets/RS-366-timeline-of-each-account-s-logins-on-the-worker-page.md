---
id: RS-366
title: Timeline of each account's logins on the worker page
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/rasbora
pr: 843
version: 1.320.0
related: []
---

## Ask

> You should also use an timeline to trace the all account performance.
> for example.
> timestamp - Login success
> timestamp - Fail ,
>
> ...

Asked where it should live, the requester picked "Expand rows in Accounts
used" and added:

> It should be in the Worker detaial page..

## Context

v1.319.0 (RS-365) added **Accounts used** to the worker page, one row per pool
account the worker has signed in with, but nothing about how each account
fared there. The coordinator already records every login a worker attempts in
its `login_attempts` ledger (`GET /v1/logins`, admin): the trigger (`boot`,
`relogin`, `forced`, `swap`, `cookie-restore`, `token-refresh`), the outcome
(`restored`, `password_ok`, `watch_ok` succeed; `challenge`, `locked`,
`failed`, `timed_out` do not), the times, the account's `identity_key`
(`uid:<facebook uid>`) and a detail with the checkpoint kind or URL. A live
sample of 500 rows since 2026-10-18 held 104 restored, 385 failed (mostly at
boot), 5 checkpoints and 2 locks. Only the newer rows carry `identity_key`;
the rest are matched by worker and time against the RS-365 stints.

rs_console did not expose the ledger, and the ERP talks only to rs_console, so
this crosses the tracker contract (root AGENTS.md → *Contracts*).

## Acceptance criteria

- [x] A row in Accounts used expands into that account's timeline, newest first, across every worker it was on.
- [x] Each login attempt is a line: time, success/failure wording (Login success, Login failed, Checkpoint, Locked by Facebook, Timed out, no result), its trigger and the worker; success green, failure red, checkpoint amber.
- [x] Pool lifecycle is on the same timeline: added (batch), assigned to a worker (by whom), taken/returned, reported or moved to Problem (reason), retired, removed.
- [x] Consecutive identical login lines (same worker, trigger, outcome) collapse to one with a count and time range, so boot loops read as one line.
- [x] The panel header sums the account's logins: n ok · n failed.
- [x] Against a console without `/v1/logins` the timeline still shows the pool events and says logins will appear once the fleet console is updated.

## Out of scope

- Worker status changes (stale, offline, session expired) and mid-sweep
  checkpoints: they belong to the worker, and the page's History aside already
  lists them.
- A per-account timeline on the Account pool tab.
- Releasing and deploying the console: a deploy rebuilds and rolls the whole
  homelab fleet, so it waits for a separate yes.

## Notes

- The console returns the ledger without `datr_fp` and `device_id`; the ERP
  has no use for device fingerprints.
- A row whose `identity_key` names another account is never attributed to
  this one, even inside its stint.
