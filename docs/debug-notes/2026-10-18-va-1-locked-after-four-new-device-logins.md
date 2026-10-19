# va-1 locked after four password logins, each from a new device

**Seen:** 2026-10-18, va-1 (`ankitweatherst2505@hotmail.com`, uid
61574553140062). **Follow-up:** RS-293.

## Symptom

Watch showed Facebook's checkpoint page: "NL, log in with another device to
unlock your account. We locked your account on October 17, 2026 because it
may have been hacked."

## Cause

- `code_audit` shows four password releases to va-1 on 2026-10-18, at 05:07,
  05:10, 05:23 and 05:44 UTC: two Re-logins and two boots after container
  restarts. Facebook dates the lock in Pacific time, and these all fall on
  October 17 there.
- The account had never finished a login on the worker, so there was no
  saved session and no recorded `datr`. Each attempt was a fresh browser with
  a new `datr`, which is how Facebook identifies a device.
- Four logins from four machines through one proxy reads as an account being
  attacked.
- The account's real device, the seller cookie's `datr` in the ERP pool, was
  never presented, because Assign deliberately keeps the pool cookie back.

## What to check next time

- **Count the attempts before pressing Re-login or restarting a worker that
  has never logged in.** `rsc vault logins --worker <id>` lists them, and
  `code_audit` holds the password releases.
- **A worker without a recorded device presents a new one on every attempt.**
  Check `rsc identity list` for the account's profile and whether it has
  device cookies.
- **The ERP liveness check isn't the cause.** It is an anonymous picture
  lookup (`fbPoolAliveCheck.ts`) and cannot lock an account.
