---
id: RS-293
title: Every Facebook login records its device, retries are capped, and a new account starts on its legacy device
type: story
status: backlog
priority: P1
created: 2026-10-18
reporter: jinhu
branch: feat/fb-login-ledger
pr:
version:
related: [RS-292, RS-291]
---

## Ask

> ultrathink design an system to also login the device id and keep the device id in the DB as well and create the VM with same device di

> also discover the legacy device id for this locked acount

(After va-1, `ankitweatherst2505@hotmail.com`, landed on Facebook's "log in
with another device to unlock your account ... may have been hacked" page.)

## Context

va-1's account (uid 61574553140062, ERP pool #2) was locked on 2026-10-17
Pacific. The coordinator's `code_audit` shows four automated password logins on
2026-10-18 between 05:07 and 05:44 UTC, still Oct 17 Pacific. The account had
never finished a login on a worker, so each attempt opened a fresh browser with
a new `datr`, the cookie Facebook uses as the device id. Nothing recorded which
device each login used, nothing capped the retries, and nothing noticed the
lock page.

RS-292 already gives each account one device profile in the DB and reuses it
on any worker or host. Its PR #727 records the `datr` Facebook issues on first
contact, and its fleet agent creates new workers with the account's device.
This ticket adds what was still missing.

**Legacy device.** The pool's seller cookie for this account (added
2026-10-17 15:58 UTC) holds `datr` `7tOaaIh2...` and no `sb`. That is the
account's original device. Assign had deliberately kept the cookie back,
because its `xs` replayed from a worker IP looks like a hijack, so no worker
ever presented it.

## Acceptance criteria

- [x] Each login opens and closes a `login_attempts` row: account, device,
      `datr` fingerprint (never the cookie), trigger and outcome.
- [x] A login starting on a `datr` the account's device does not hold pages
      ops.
- [x] `/v1/auth/credentials` refuses an account after 2 password releases in
      24 h, and while it is locked; the refusal is audited.
- [x] Facebook's lock page is challenge kind `locked`. A login ending there,
      or a `locked` escalation, locks the account until `rsc vault unlock`.
- [x] With `RS_REQUIRE_FB_UID=1`, an account without a uid gets no password.
- [x] Assign sends the pool cookie's `datr`/`sb` only. The console passes
      only those, and the coordinator seeds the account's device with them
      when it has none. A device that already has cookies is never
      re-seeded.
- [ ] Live: after deploy, the uid backfill and a seed, va-1's next login
      starts on the legacy `datr`'s fingerprint.

## Out of scope

- Unlocking va-1 on Facebook. That is the account owner's call: a device that
  has used the account before, or "Start security steps".
- Buffering ledger events while the coordinator is down. The ledger is best
  effort, and a login is never held up by it.
- Showing locks and the ledger in the ERP. The CLI and `GET /v1/logins` cover
  it for now.

## Notes

- Split with the RS-292 session: they built the first-contact device record
  (A, PR #727). This ticket covers the ledger, the budget and lock, the uid
  gate, and the seed from the pool.
- `RS_REQUIRE_FB_UID` stays off until `rsc identity learn-uids --apply` has
  backfilled the uids. Turned on first, it would stop every password login.
