---
id: RS-254
title: Manage each worker's Facebook login and password from the fleet page
type: story
status: done
priority: P2
created: 2026-10-13
reporter: Jinhu
branch: feat/fleet-account-credentials
pr: 638
version: 1.259.0
related: [RS-164, RS-170]
---

## Ask

> Think of the best approach to update the username and password for each worker.
>
> I hope i can use the ERP system UI to manage worker;s username and password, when i click the relogin, it can use the username and password that i assigned to it.
>
> go ahead ajs take your recommand approach

## Context

Re-login (RS-164, fixed in RS-170) already does the second half of the ask:
the worker drops its session within about five minutes and, when it logs in,
asks the coordinator's vault for the account's username and password
(`/v1/auth/credentials`) and fills the 2FA code from the vault's TOTP secret.
It can only do that for an account that has a password stored **and**
`allow_password_login` set. On 2026-10-13 no account qualified: the vault held
one account (homelab-1, TOTP only, no password) and the other five workers had
no vault row at all, so every Re-login parked on Facebook's login form for a
by-hand login in Watch.

The missing piece was the write path. The only way to set a login was `rsc
vault set-account` inside the coordinator container on the VM. facebook_tracker
now exposes `PUT /v1/accounts/{account_id}` on the coordinator (admin token)
and forwards it through the console facade, reduced to a fixed field list:
`worker_id`, `fb_username`, `region`, `allow_password_login` and a write-only
`secrets` object (`password`, `totp_secret` and the e-mail code fields). A
field left out keeps its value, an empty secret keeps what is stored, `null`
clears it, a TOTP key is validated as the CLI validates it, and a worker cannot
be registered on an account another account owns (409). The answer is the
same presence-flag view the fleet page already reads (`account.secrets`,
`account.allow_password_login`), so the page can say, before and after
saving, whether Re-login will finish by itself.

This ticket is the ERP half: the backend forward and the form.

## Acceptance criteria

- [x] `PUT /api/coordinator/accounts/:id` (manager-only) forwards to the
      facade's `/v1/accounts/:id` with the body reduced to the allowed fields
      and secret names; unknown fields (a proxy, a VNC URL) never leave the ERP.
- [x] The backend logs the account id and the field *names* written, never a
      value, and relays the coordinator's refusal (409 on a worker owned by
      another account) verbatim.
- [x] The Account information table has a **Credentials → Edit** button per
      worker that opens a form with Facebook login, password, 2FA secret and
      "Allow password login"; password and 2FA boxes show only whether a value
      is stored, blank keeps it, and each has a "clear" option.
- [x] A worker with no vault account gets one named after the worker on save.
- [x] The form says whether Re-login will be automatic after saving, and a
      successful save refreshes the fleet view (the stored-secret badges and
      the Re-login dialog's wording follow).
- [x] `en` and `zh` strings are in parity.

## Out of scope

- Setting a worker's proxy or VNC URL from the ERP; both stay on `rsc vault
  set-account` (the proxy URL carries credentials of its own).
- Moving a worker between vault accounts (the coordinator refuses it; detach
  on the VM first).
- Reading a secret back, ever. The form is write-only by design.
- A credentials button for a worker that has neither a vault account nor a
  backed-up session (it is not in the Account information table at all).

## Notes

- The coordinator-side change lives in facebook_tracker (`rs_coordinator`
  `PUT /v1/accounts/{id}`, `rs_console` forward); the coordinator **and** the
  console containers on the VM must be rebuilt for the form to work. The
  worker image is unchanged for this feature.
- Trade-off accepted: the facade token the ERP holds can now *set* a worker's
  login. It still cannot read one — the route returns presence flags only.
