---
id: RS-171
title: "Account Pool page: manage vault accounts from the ERP"
type: story
status: in-progress
priority: P2
created: 2026-10-04
reporter: Jinhu
branch: feat/account-pool
pr:
version:
related: [RS-164, RS-170]
---

## Ask

> help me create a dedicated account pool page in our erp system and it will connect to the vault.
> i am manually update or edit on the erp system.

## Context

The Facebook worker accounts live in the coordinator's encrypted vault. Until
now the only way to add or change one was `rsc vault set-account` on the fleet
VM; the ERP could only see the accounts already bound to a worker, read-only,
inside the fleet page. The owner wants to keep the pool by hand from the ERP.

The ERP reaches the vault through the rs-console facade, which until now
forwarded no route that names an account or moves a credential. This needs the
fleet side (facebook_tracker: coordinator `POST/PATCH /v1/accounts`, facade
forwards) deployed first.

Owner decisions, 2026-10-04:

- Secrets are **write-only** from the ERP. A password, TOTP key or mailbox
  login can be typed in and saved; nothing ever reads one back — the page shows
  only whether each is stored.
- **No delete** from the ERP. An account can be created, edited and
  un-assigned (back to the pool); removing one stays `rsc vault rm` on the VM.

## Acceptance criteria

- [x] A manager-only **Account Pool** entry under Monitors opens a page listing
      every vault account, assigned or not, with which secrets are stored.
- [x] A manager can create an account and edit its Facebook login, worker
      (including un-assigning it), region and secrets (password, e-mail login,
      e-mail password, TOTP key, IMAP host and port).
- [x] A blank secret field keeps what is stored; a cleared one removes it.
- [x] No secret value is ever rendered, returned by the ERP API, or logged.
- [x] Purchasers see no nav entry and get 403 from the API routes.
- [x] Against a facade without the account routes the page shows a quiet
      notice instead of an error.

## Out of scope

- Deleting an account (stays on the VM).
- Revealing a stored secret.
- Turning password login on, the proxy and the VNC link — still set on the VM;
  the page shows password login read-only.
- The phone shell.

## Notes

- The facade's safety property changes from "no write names an account" to
  "a stolen console token can write accounts but never read a secret, delete
  one, or turn password release on". Residual risk the owner accepted: the
  console token **plus** one compromised worker VM could assign another account
  to that worker and receive its 2FA codes. Mitigations on the coordinator:
  changing an account's worker turns its password login off, and every
  re-assignment raises a Telegram ops alert naming who made it.
- Setting a new mailbox address, IMAP host or port must re-send the mailbox
  password in the same save, so a changed host can never receive the stored
  one. Clearing them is allowed on its own (a cleared host falls back to the
  address's well-known one); the first cut refused that too, which made a
  mailbox login impossible to remove.
- Verified end to end on 2026-10-04 against a local coordinator + rs-console
  (throwaway vault): create with password, TOTP and mailbox login; edit
  region, un-assign and clear the TOTP key; `rsc vault list` agrees. None of
  the typed secrets appeared in any API response or in the ERP, console or
  coordinator logs; the coordinator logged the manager's name and field names
  only. Against a stub facade answering 404 the page showed the notice.
