---
id: RS-445
title: Keep the pool's session backup current in every worker state, and show it on the Account Pool page
type: story
status: done
priority: P2
created: 2026-10-28
reporter: jinhu
branch: JinhuW/lanternfish
pr: 979
version: 1.377.0 (ERP), facebook-tracker 0.14.17
related: []
---

## Ask

> yes, add the session upload before stop. update the current account pool to also include in the UI. Seem the cookie didn't get update in the DB? double check for me
>
> Let we upload the session as well. How about the access token?
>
> 2. It should upload no matter the status
> The updated cookies and seesion pls shows in the account pool UI.

## Context

A healthy ERP-fleet worker saves its browser session and uploads it to the
pool (`fb_pool_accounts.cookie_enc`, `cookie_at`) every 30 min
(`session_save_s`), and again on `docker stop` (`FacebookMarketplace.stop()`),
so the "upload before stop" asked for already existed.

Two states never saved:

- **Parked for an operator** (`_fleet_park`: connect_failed, login_failed,
  crashed, browser_failed). The loop only slept and polled the epoch.
- **Walled.** `check_session` returned before the save while a checkpoint or
  block wall stood.

So the pool copy froze at the moment of trouble, and that copy is what a
replacement container restores. `homelab-4` (#45) was 17 h behind its browser
on 2026-10-28, and `worker-60-14-3` (#55) has been frozen since 2026-10-27
15:50.

On the Account Pool page the Cookie cell read whole days ("0 d old"), so a
backup minutes old and one 23 h old looked the same. It also didn't say who
wrote the backup, or whether it holds a full browser session or a bare cookie.

The access token is never refreshed by workers. It can't mint a web session
(`auth.getSessionForApp` is gated to first-party apps), so it stays as
imported.

## Acceptance criteria

- [x] A worker parked by `_fleet_park` saves and uploads its session every
  `session_save_s` (the first time as it parks) while the browser is logged
  in. It never navigates, logs in or reports a new state.
- [x] A walled worker also saves and uploads on that schedule, without lifting
  the wall.
- [x] A logged-out browser, or one on a checkpoint URL, uploads nothing, so the
  pool keeps its last good session.
- [x] `fb_pool_accounts.cookie_by` records who wrote the backup: the worker id
  from `PUT /api/fleet/worker/session`, the user's name from a pool import or
  edit that changes the cookie.
- [x] The pool snapshot returns `cookieBy`.
- [x] The Account Pool Cookie cell shows the age in minutes, hours or days and
  keeps the fresh/stale rule. Its tooltip gives the exact time and who wrote
  the backup.
- [x] The account editor's Session section shows what the backup holds
  (cookies and site storages), when it was saved, and by whom.

## Out of scope

- Uploading or refreshing the access token: it can't log a browser in.
- Resume in place after a page timeout, an honest `browser_ok` while parked,
  and pilot mode: separate tickets.
- Recreating the workers to run the new monitor. That is a login per worker
  and waits for the owner's go-ahead.

## Notes

- Monitor patch `1550b6e` on `recycle-patches` (pushed to the private mirror).
- A checkpoint URL still refuses the save
  (`test_a_checkpoint_interstitial_does_not_overwrite_it_either`). That keeps
  the existing rule, under which `xs` on a checkpoint page is not proof of a
  live session.
