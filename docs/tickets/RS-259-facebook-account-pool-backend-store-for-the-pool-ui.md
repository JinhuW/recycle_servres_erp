---
id: RS-259
title: Facebook account pool: backend store for the pool UI
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fb-pool-backend
pr: 663
version: 1.262.0
related: [RS-254]
---

## Ask

> You already build the account ui. Think of how to build the backend to keep tracking these information.

## Context

v1.261.0 shipped the Facebook account pool page at **Monitors ▸ Facebook ▸
Account pool** (`/fleet/pool`) as a labelled frontend demo: the accounts, the
takes and returns, the imports and the activity log lived in React state and
vanished on reload, and nothing was shared between a manager and the
purchasers. The page already fixed the model — five statuses, a purchaser
holds at most two accounts, held over seven days is flagged, a cookie older
than 21 days is amber, batch labels, a per-pool `#`, a who-did-what log — so
the backend's job is to persist exactly that model, enforce the rules
server-side, and keep the logins safe at rest.

Two things shaped the design:

- The pool holds third-party credentials (Facebook passwords, 2FA setup keys,
  e-mail passwords, session cookies) that the page has to hand back in clear
  so a purchaser can copy them and see a live 2FA code. Everything else the
  database stores is hashed; these cannot be, so they are sealed with
  AES-256-GCM under a key of their own (`FB_POOL_KEY`), separate from
  `JWT_SECRET`, and blanked by the nightly prod→dev copy.
- The Facebook fleet (`trackers/facebook`) already keeps its own encrypted
  vault of *worker* logins, which the ERP writes through the console facade
  and can never read back (RS-254). The pool is the human side of the
  picture: spares, the accounts purchasers hold, and the ones that need a
  manager. `fleet` is a label naming which worker an account went to.

## Acceptance criteria

- [x] A manager's add, import, edit, retire and remove at `/fleet/pool`
      persist across reloads and are visible to every other user.
- [x] A purchaser's take, return and report persist; they see every account's
      status, holder, age and cookie check, but the login of an account only
      while they hold it; the activity log is not sent to them.
- [x] The API refuses the third take (`409 fpAtLimit`), a take of an account
      someone else just took (`409 fpTakenElsewhere`), a return or report by
      anyone but the holder or a manager (403), and a manager route called by
      a purchaser (403).
- [x] An import is all-or-nothing and names the rows whose uid collided.
- [x] Passwords, 2FA keys, e-mail passwords and cookies are stored as sealed
      blobs, never in clear; the nightly prod→dev scrub blanks them.
- [x] Every action lands in an append-only ledger with who, which account,
      what and the status after; copies and reveals of a login are recorded too.
- [x] The `#` is never reused: a removed account leaves a gap.
- [x] Without `FB_POOL_KEY` in production the pool routes answer 503 and name
      the variable; nothing else is affected.

## Out of scope

- **Pushing a `fleet` account's login into the coordinator vault** through
  `PUT /v1/accounts/<id>` — the natural next step, kept out so the store ships
  first and the write-only contract of RS-254 is reconsidered on its own.
- **The unified Activity feed** (`/api/activity`): the pool keeps its own
  ledger on its own page.
- **The mobile shell**: the pool is desktop-only, as shipped in v1.261.0.

## Notes

- Shipped in #663 as v1.262.0. `FB_POOL_KEY` was set on the Railway `backend`
  service in both `dev` and `production` (no redeploy; each picks it up on its
  next deploy).
- Verification: backend suite files `facebook-pool`, `sealed`, `sync-scrub`,
  `fk-indexes`, `env`, `coordinator-routes`; full frontend suite; `vite build`;
  the local stack driven over the API as Alex / Marcus / Priya through import →
  edit → take ×2 → limit → forbidden return → copy audit → return → report,
  with the ledger and the sealed blobs checked in Postgres.
- Secrets at rest were the one decision put to the requester; they chose
  encryption with a dedicated key over plain columns.
- `FB_POOL_KEY` is 64 hex characters (`openssl rand -hex 32`), one per
  environment. Outside production the key is derived from `JWT_SECRET`, so
  dev, CI and the test suite need nothing new. Rotating the key orphans every
  stored login; there is no re-key tool yet.
- The fleet vault and the pool are two stores on purpose. The coordinator
  reads nothing from the ERP, and the console's allowlist forwards no route
  that reads a credential back, so the ERP is the only place the pool's
  logins are legible.
