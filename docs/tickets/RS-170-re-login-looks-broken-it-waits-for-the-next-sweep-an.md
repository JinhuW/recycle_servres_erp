---
id: RS-170
title: Re-login looks broken: it waits for the next sweep and cannot sign in without a stored password
type: bug
status: in-progress
priority: P2
created: 2026-10-04
reporter: Jinhu
branch: fix/relogin-honest
pr:
version: 1.208.2
related: [RS-164]
---

## Ask

> fix the re-login, It doesnot work

## Context

Traced end to end on 2026-10-04 with homelab-1: the ERP (200), the console and
the coordinator all passed the request on, and the worker logged "Re-login
requested by operator" at its next heartbeat (13:26:42). Two things then made
the button look dead:

1. **The worker acted on it only at its next search cycle.** Sweeps run once a
   day (`start_at`), so the re-login was scheduled for 10:00 the next morning.
   Fixed in facebook_tracker `8b6c28d`: the idle loop wakes on the directive
   and logs in at once (within one heartbeat, about 5 minutes).
2. **No worker can sign in by itself.** homelab-1's vault account has a TOTP
   secret but no password, and password login is not allowed; the other
   workers have no vault account. A forced re-login therefore clears the
   session and parks Facebook's login form. Finishing it by hand in Watch now
   takes effect within ~15 s (facebook_tracker `34c4116`) instead of at the
   next sweep.

This ticket is the ERP half: the dialog said "on its next search cycle" and
promised an automatic password + 2FA login that cannot happen.

## Acceptance criteria

- [x] The Re-login dialog says it happens within about 5 minutes.
- [x] For a worker without a stored password it may use (password secret and
      `allow_password_login`), the dialog says the worker will open the login
      page and the operator finishes in Watch → Take control, with the vault
      command that makes it automatic.

## Out of scope

Storing Facebook passwords in the vault — an owner decision per account.
