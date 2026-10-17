---
id: RS-284
title: Weekly liveness check for the Facebook account pool
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fb-pool-alive-check
pr: 711
version: 1.280.0
related: [RS-259]
---

## Ask

> Seem there is a way to check if a facebook account is still active.
> Help me set a task to check if the accounit in my facebook account pool still active everyweek. it does not be a cron job.
> If the account dead, the update the status here.

(With a screenshot of the Account pool table at `/fleet/pool`: eight accounts,
all Available.)

## Context

A pool account (`fb_pool_accounts`, v1.262.0) only changes status when someone
acts on it, so an account Facebook has disabled sits as Available until a
purchaser takes it and finds out.

Facebook's public picture endpoint answers without a login or a token, and
gives a usable signal. `GET https://graph.facebook.com/<uid>/picture?redirect=false`,
probed on 2026-10-17, returned three shapes:

- An existing account (all eight pool UIDs, and uid 4) gets a `data.url` on
  `scontent…fbcdn.net` that carries `height` and `width`.
- An unknown UID gets a `data.url` placeholder on `static.xx.fbcdn.net/rsrc.php/…gif`,
  with no dimensions.
- Another unknown UID gets `error` "Object with ID … does not exist".

This is an anonymous lookup, not a session, so it does not carry the
"activity from an unexpected IP" risk that `/assign` guards against.

## Acceptance criteria

- [x] Every Available, Taken and In-fleet account is probed at least once
      every 7 days, and a restart or deploy does not reset the clock.
- [x] When a probe says the account is dead, the account moves to Needs
      attention (`problem`) and keeps its holder. The ledger gets a
      `reported · disabled` line by "Weekly check".
- [x] A probe that fails or can't be read (HTTP error, timeout, an unexpected
      body) changes nothing, and that account is tried again on the next tick.
- [x] Needs-attention and retired accounts are never probed.
- [x] A manager's edit made during a pass wins: the check never overwrites a
      status that changed after the account was picked.
- [x] The pool page shows when each account was last checked.

## Out of scope

- **Cron, Railway or external schedulers.** The requester said not a cron job.
  It is a backend loop, and "weekly" is stored per account in the database.
- **Auto-retiring dead accounts.** Needs attention leaves the call to a
  manager, in case of a false positive.
- **Detecting checkpoints.** A locked but recoverable account still looks
  alive to this probe. For accounts in the fleet, the workers' heartbeat
  `CHECKPOINT` state already shows it.
- **A "Check now" button.**

## Notes

- The placeholder signal was confirmed only for UIDs that never existed. No
  known disabled UID was available to test against.
