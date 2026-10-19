---
id: RS-308
title: Assign restores a pool account's cookie session instead of a password login
type: story
status: done
priority: P2
created: 2026-10-18
reporter: jinhu
branch: fb-cookie-login
pr: "#760"
version: facebook-tracker 0.12.5, v1.290.0
related: [RS-293, RS-292, RS-259]
---

## Ask

> Some of  facebook account has cooikes. ultrathink of an approach to login with cooike.

(Chosen while planning: **cookie-first, password fallback** — restore the cookie
session when the account has a usable one, fall back to the password login only
when the restore does not take.)

## Context

A pool account (`fb_pool_accounts`, v1.262.0) can carry a live Facebook session
cookie: `cookie_enc` sealed, `cookie_uid` = its `c_user`, `cookie_at` its age.
The pool page grades it `fresh` (≤21 days) / `stale` / `mismatch` / `none`
(`cookieHealth`, `apps/frontend/src/lib/facebookPool.ts`).

Assigning such an account to a fleet worker
(`apps/backend/src/routes/facebookPool.ts` `/:no/assign`) writes the account's
**password** into the worker's vault and queues a forced `relogin` — a fresh
password login plus 2FA from the worker's proxy IP, the single harshest signal
to Facebook. The cookie's live session (`c_user`/`xs`) is deliberately withheld,
because replaying `xs` from a worker IP looks like a session hijack.

RS-293 (facebook-tracker 0.12.2) already made the account's **device** travel:
`/assign` ships the cookie's `datr`/`sb` device cookies and the `fb_uid`, and the
coordinator seeds the account's `device_profiles` row, so whichever worker runs
the account presents the account's own browser fingerprint. What is still missing
is presenting the **session** itself for accounts that have a cookie — so a login
costs no password, no 2FA, and no login form.

The machinery to do it already exists and is reused rather than rebuilt:

- **Cookie → `storage_state`** conversion, validated (requires `c_user`+`xs`,
  carries `datr`/`sb` and facebook origins, three input formats):
  `trackers/facebook/rs_poster/rs_poster/cookies.py`.
- **Per-worker encrypted session snapshot + restore** keyed on the account's
  `identity_key`: `rs_coordinator/.../routers/session.py` (`snapshot_restorable`,
  `backup_session`, `restore_session`).
- **Worker restore path**: the vendored monitor's `refresh_identity(restore=True)`
  and `restore_session_backup()` already pull the coordinator's snapshot onto disk
  when the local file holds no session and the snapshot's `identity_key` matches
  the account's.

The residual IP/fingerprint risk is mitigated by RS-293's travelling device
(same `datr`/`sb`, viewport, UA, timezone) and by the password fallback when a
restored session does not take.

## Acceptance criteria

- [x] The coordinator seeds a worker's session snapshot from a cookie: a new
      admin route accepts the cookie (header / JSON-array / JSON-object),
      validates `c_user`+`xs`, **refuses when the cookie's `c_user` is not the
      worker's account uid**, seals it, and upserts `session_snapshots` tagged
      with that account's `identity_key` so `snapshot_restorable` passes. The
      disclosure is audited (`session` kind in `code_audit`).
- [x] A `restore` directive (distinct from `relogin`) makes the worker restore
      the seeded snapshot and reach Marketplace logged in **without any
      credential release** — the login runs unforced, so `login` takes its
      restore path, and the ledger records a `cookie-restore` trigger.
- [x] When the restored session is absent or lands on a checkpoint/login wall,
      the worker falls back to the existing password `relogin` flow unchanged.
- [x] `/assign`: when the account's cookie is its own (its `c_user` matches the
      account uid), it seals the cookie and queues `restore`; any other cookie
      state keeps today's password `relogin`. The vault login,
      `allow_password_login` and the RS-293 `legacyDevice` are still written so
      the password fallback and the device travel work.
- [x] The console forwards the two new routes (field-sanitised) and is
      backward-compatible, so it ships before the ERP release. The ERP drives
      the seed and restore server to server through the existing `callFacade`
      (no public proxy route), so the console allowlist is the only new surface.

## Out of scope

- A proxy↔cookie-origin geo warning at assign time. The device travels
  (RS-293) and the password fallback covers a checkpoint, so this is a
  follow-up, not part of logging in from a cookie.
- Capturing or importing cookies into the pool — already `rs-session import`
  and the pool account editor.
- Auto-refreshing a stale cookie, or rotating proxies to find a matching exit.
- Surfacing the login ledger / restore history in the ERP — the CLI and
  `GET /v1/logins` cover it (RS-293).

## Notes

- Plan: `docs/superpowers/plans/` (approved implementation plan for this ticket).
- Builds directly on RS-293 (device travels) and RS-292 (device profiles).
- Conversion lives in the coordinator via a dependency on `rs_poster.cookies`
  (precedent: `rs_messenger` already depends on `rs_poster`), so there is one
  authority for what a valid session looks like rather than a TS reimplementation.
