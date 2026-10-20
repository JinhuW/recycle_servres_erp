---
id: RS-338
title: Worker logs in with cookie then token, password last
type: story
status: done
priority: P2
created: 2026-10-20
reporter: jinhu
branch: facebook-worker-cookie-token
pr: "#808"
version: facebook-tracker 0.13.10, v1.308.0
related: [RS-308, RS-293, RS-292]
---

## Ask

> I hope the facebook can login with cookie+token in the worker.

(Chosen while planning: **cookie → token → password**. Keep RS-308's cookie
restore first; when the restored session is dead, mint a fresh session from the
account's stored access token through the worker's own proxy; fall back to the
password login only when both fail. Also teach the pool importer the vendor
order sheet, whose columns carry that token.)

## Context

Vendor Facebook accounts ship a long-lived access token (the `令牌` /
`EAAD6V…` column in the order sheet) alongside the session cookie. A token can
mint a fresh browser session for its own account without a password or 2FA,
which is both cheaper and far safer than the password `relogin` — the single
harshest signal to Facebook, capped at 2/day/account.

RS-308 (facebook-tracker 0.12.5) made Assign seed the account's cookie and queue
a `restore`, so a worker with a live cookie logs in with no password. But a
cookie session lapses in ~weeks, and the only fallback today is the password
login. Nothing stores or ships the token, and the vendor order sheet (a quoted
comma CSV, header `序号,账号(UID),密码,2FA/验证码,Cookie,令牌,邮箱,邮箱密码`,
cookie and token before email, no recovery column) cannot be imported at all —
today's `parsePoolImport` only reads tab/`----`/`|` in a fixed order.

The machinery is reused, not rebuilt:

- **Cookie → `storage_state`** conversion + validation (`c_user`+`xs`):
  `trackers/facebook/rs_poster/rs_poster/cookies.py`. The worker image ships
  only the AGPL monitor (no `rs_poster`), so the token→session converter is a
  self-contained sibling in the monitor (`ai_marketplace_monitor/token_session.py`)
  that returns the same validated `{cookies, origins}` shape.
- **Vault credential release** (per-worker token, audited, opt-in):
  `rs_coordinator/.../routers/auth.py`. The token release mirrors the password
  release but carries no daily budget — a refresh is not a fresh password login.
- **Worker login fallthrough**: the vendored monitor's `login()` already runs
  restore → `is_logged_in()` → escalate → password. The token step slots in
  between the restore check and the password block.

A latent bug is fixed in passing: the worker already tags a cookie-restore login
`trigger="cookie-restore"`, but the coordinator's `LOGIN_TRIGGERS` omits it, so
that ledger write 422s and silently drops. The new `token-refresh` trigger is
added to the same list.

## Acceptance criteria

- [x] The pool stores a per-account access token, sealed at rest
      (`fb_pool_accounts.token_enc`), surfaced in the account editor's Session
      section and never returned to the browser in clear.
- [x] The importer reads the vendor order sheet as-is: quoted comma CSV, a
      header row that maps columns by name (EN + ZH, incl. `令牌`/token), cookie
      and token before email, no recovery column. The existing tab/`----`/`|`
      positional formats still parse, now with an optional token column. A
      token that is not `EAA…` warns but does not block.
- [x] Assign writes the account's token into the worker's vault
      (`fb_token`, sealed) alongside the RS-308 cookie seed and device travel;
      the cookie seed + `restore` directive are unchanged.
- [x] A worker whose restored cookie session is absent or dead mints a fresh
      session from its stored token, inside its proxied browser context (so the
      request carries the account's own IP and `datr`/`sb`), reaches Marketplace
      logged in with no credential-password release, and the ledger records a
      `token-refresh` attempt ending `restored`.
- [x] When no token is stored, or the token refresh lands on a
      checkpoint/login wall, the worker falls back to today's password `relogin`
      unchanged.
- [x] The token release is audited (`token` kind in `code_audit`), refused on a
      locked account, and not counted against the password/day budget. The
      `cookie-restore` ledger trigger is accepted (regression fix).
- [x] The console allows `fb_token` on the account write and stays
      backward-compatible, so it ships before the ERP release.

## Out of scope

- Refreshing or validating the token's own expiry, or rotating proxies to find
  a matching exit. The password fallback covers a dead token.
- A proxy↔token-origin geo warning at assign time (same reasoning as RS-308).
- Surfacing token/login history in the ERP — the CLI and `GET /v1/logins`
  cover it.

## Notes

- Plan: `~/.claude/plans/whimsical-growing-pancake.md` (approved).
- Builds on RS-308 (cookie-first assign), RS-293 (device travels), RS-292
  (device profiles).
- Token→session conversion lives in `rs_poster.cookies` so there is one
  authority for what a valid session looks like (RS-308 precedent).
