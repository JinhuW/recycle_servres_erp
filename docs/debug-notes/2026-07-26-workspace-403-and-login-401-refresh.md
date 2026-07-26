# 2026-07-26 — Two defects found in Railway prod logs

Found by reading the Railway **production** `backend` deploy logs
(deployment `2a116f95`, commit `b24e8d5`). No unhandled 500s existed in the
window — both defects were visible only as recurring 4xx patterns.

## 1. `GET /api/workspace` 403s every non-manager, silently pinning them to SPA fallbacks

**Log signature** — 403 immediately *after* a successful login, while every
other authenticated call on the same fresh cookie returns 200:

```
POST /api/auth/login  200 141ms
GET  /api/lookups     200  24ms
GET  /api/workspace   403   4ms   <-- valid session, role-denied
GET  /api/orders      200  12ms
```

Seen 2026-07-26 at 11:07, 12:09, 14:03 UTC. A manager login at 19:41 got 200,
which is what identifies it as role-dependent rather than an auth failure.

**Root cause.** Commit `024148b` ("prod-readiness audit") added
`if (c.var.user.role !== 'manager') return 403` to `GET /api/workspace`,
mirroring the PATCH guard. The intent — don't leak pricing/margin config to
purchasers — was right, but the frontend calls `loadWorkspaceSettings()` at
boot **and** after every login for *every* user (`lib/auth.tsx`), and
`wsNumber('low_health_pct', 50)` is read by `pages/Inventory.tsx`, a purchaser
screen.

So the blanket 403 hid nothing extra and instead **silently reverted every
purchaser to the SPA's hardcoded fallbacks**. If a manager sets
`low_health_pct` to 70, managers see 70 and purchasers still see 50 — the exact
divergence migration `0025` existed to eliminate. The failure was invisible
because `auth.tsx` catches the rejection with a `console.warn` and continues.

**Fix.** Filter by key instead of rejecting the request:
`PURCHASER_VISIBLE_SETTINGS` (currently just `low_health_pct`) is returned to
everyone; managers still get the whole map. Pricing/upload/notification keys
stay manager-only, so the security intent is preserved.

**Trap for next time:** a role guard on a *read* endpoint that the SPA loads
unconditionally at boot does not produce a visible error — it produces a silent
fallback. Before manager-gating a GET, grep for its client caller and check
whether a non-manager screen consumes any of the response. Add a key to
`PURCHASER_VISIBLE_SETTINGS` only when a non-manager screen actually renders it.

## 2. A 401 from `POST /api/auth/login` was treated as an expired access cookie

**Log signature** — every failed login is trailed by a pointless refresh:

```
POST /api/auth/login    401 106ms
POST /api/auth/refresh  401   1ms
POST /api/auth/login    401  84ms
POST /api/auth/refresh  401   1ms
```

Five such pairs between 00:08:33 and 00:08:46 UTC on 2026-07-26 (someone
mistyping a password; the run ended in the login rate limiter's 429s, which
worked correctly).

**Root cause.** `lib/api.ts request()` exempted only `/api/auth/refresh` from
the 401→refresh→retry path. A 401 from `login` means *wrong password*, not
*expired cookie*, so the client fired a refresh that could never succeed and
then dispatched `auth:unauthorized` — which runs `clearLocalAuthState()` and
wipes the already-loaded lookups/workspace caches on every typo.

**Fix.** `isSessionEndpoint()` now exempts both `/api/auth/login` and
`/api/auth/refresh` from the refresh-and-retry path.

**Trap for next time:** the 401→refresh handler must never wrap an endpoint
whose job is to *establish* a session. If a new one is added (SSO callback,
re-auth prompt), add it to `isSessionEndpoint`.

## Not bugs (checked and dismissed)

- `GET /` and `GET /.env` → 403: the `PROXY_SECRET` origin lockdown correctly
  refusing bots that hit the Railway origin directly, bypassing the Worker.
- `GET /.well-known/security.txt` → 404: scanners reaching the public domain
  through the Worker; `app.notFound` is doing its job.
- `POST /api/auth/login` → 429: the login rate limiter, working.
