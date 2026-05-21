# Frontend Auth Overhaul — httpOnly Cookies + Refresh Rotation

Date: 2026-05-18
Status: Approved-in-principle (standing user delegation); pending written-spec review.

## Problem

The JWT lives in `localStorage` (`recycle_erp_token`) and is attached as an
`Authorization: Bearer` header. Any XSS can exfiltrate a long-lived (14d)
session token, and there is no server-side revocation or refresh path — a
single mid-session 401 destroys in-progress work, and a deactivated user's
token stays valid until natural expiry.

## Key context (decided constraints)

- **Same-origin in prod and dev.** Prod: Caddy serves the SPA and reverse-
  proxies `/api/*` to `backend:8787` on one origin. Dev: Vite proxies `/api`
  → `localhost:8787`; the SPA already uses relative `/api/...` paths. No
  cross-site cookie / `SameSite=None` / CORS-credentials complexity.
- Mobile is the same web SPA (not a native webview).
- No external API consumers → clean **big-bang** cookie-only cutover (no
  dual bearer/cookie path).

## Decisions

1. **Token model: access + refresh + rotation.**
   - Access JWT, ~15 min TTL, httpOnly cookie `at`, `Path=/`.
   - Refresh: opaque 256-bit random, ~14d TTL, httpOnly cookie `rt`,
     `Path=/api/auth`. Stored as SHA-256 hash in `refresh_tokens` with a
     `family_id`. Rotated on every use; presenting a revoked (already-rotated)
     token revokes the entire family (theft response). Refresh denied for
     inactive users.
   - Cookies: `HttpOnly`, `SameSite=Lax`, `Secure` iff `NODE_ENV=production`.
2. **CSRF: SameSite=Lax + required custom header.** Backend rejects any
   non-GET/HEAD/OPTIONS request lacking `X-Requested-By: recycle-erp`
   (exempt `/api/health`). SPA api client always sends it. No CSRF-token
   plumbing.

## Backend changes

- **Migration `0034_refresh_tokens.sql`** (idempotent `CREATE TABLE IF NOT
  EXISTS`): columns `id uuid pk default gen_random_uuid()`, `user_id uuid
  not null references users(id)`, `token_hash text not null unique`,
  `family_id uuid not null`, `expires_at timestamptz not null`,
  `revoked_at timestamptz`, `created_at timestamptz not null default now()`.
  Indexes: `(user_id)`, `(family_id)`, `(token_hash)`.
- **`src/auth.ts`**: access TTL → 15m; helpers `issueRefresh(sql,userId)`,
  `rotateRefresh(sql,rawToken)`, `revokeFamily(sql,familyId)`,
  `revokeUserRefreshTokens(sql,userId)`; `cookieOpts(env)` single source of
  cookie flags; `setAuthCookies` / `clearAuthCookies`. `authMiddleware`
  reads the `at` cookie (Bearer path removed) — still loads user and
  enforces `active = TRUE`.
- **`src/routes/auth.ts`**:
  - `POST /api/auth/login` — unchanged auth + rate-limit; on success sets
    `at` + `rt` cookies, returns `{ user }` (no token in body).
  - `POST /api/auth/refresh` — reads `rt`; rotate (issue new `rt`, revoke
    old); reuse of a revoked token → `revokeFamily` + 401; success reissues
    `at` (+ rotated `rt`), returns `{ ok: true }`. Denied if user inactive.
  - `POST /api/auth/logout` — revoke current family, clear both cookies.
  - `/demo-accounts` unchanged.
- **`/api/auth/*` stays unauthenticated** (mounted before `authMiddleware`,
  as today). `/api/auth/refresh` authenticates via the `rt` cookie itself,
  NOT the access-cookie middleware, so an expired `at` does not block
  refresh. The CSRF middleware still applies to it (the api client sends
  `X-Requested-By` on refresh/login/logout).
- **CSRF middleware** mounted in `src/index.ts` before routes; exempts
  safe methods (GET/HEAD/OPTIONS) and `/api/health`.
- **`src/routes/members.ts`** deactivate → also
  `revokeUserRefreshTokens(targetUserId)`.

## Frontend changes

- **`src/lib/api.ts`**: remove `localStorage`/`auth.token`/`Authorization`;
  every request gets `credentials:'include'` and header
  `X-Requested-By: recycle-erp`. On a 401: a single-flight
  `POST /api/auth/refresh`; on success retry the original request once; on
  failure emit `auth:unauthorized`. Refresh itself never recurses.
- **`src/lib/auth.tsx`**: `login()` posts credentials, server sets cookies,
  response is `{ user }`; no client token storage. Bootstrap = call
  `/api/me`; on cold load the `at` cookie may be expired while `rt` is still
  valid — this deliberately rides the same 401→silent-refresh→retry path in
  `api.ts` (no separate bootstrap-refresh logic). If refresh also fails the
  user is unauthenticated. `logout()` → `POST /api/auth/logout` then local
  reset. `tokenStore` removed; the `auth:unauthorized` handler stays.

## Test-harness migration

`tests/helpers/app.ts` `api()` and `tests/helpers/auth.ts` `loginAs()` keep
their **current signatures and return shapes** so the ~37 backend test files
need no per-test changes:
- `loginAs()` performs the login, captures `Set-Cookie`, returns
  `{ token, user, session }` where `session` is a cookie jar; `token` is a
  back-compat shim.
- `api()` sends the session's cookies (or maps a passed `{ token }` to a
  synthesized `at` cookie) and always sends `X-Requested-By`.
- A `multipart()` helper gets the same treatment.

## New tests (TDD)

- refresh rotates and reissues a working access cookie;
- replaying a rotated refresh token → 401 + whole family revoked;
- refresh/access denied after the user is deactivated, and deactivation
  revokes existing refresh tokens;
- mutation without `X-Requested-By` → 403; GET without it → 200;
- `logout` revokes the family (subsequent refresh fails);
- login no longer returns a token in the body but sets cookies;
- frontend: api client silently refreshes once on 401 then retries; a second
  consecutive 401 logs out (covered by existing frontend vitest patterns).

## Error handling

Missing/expired `at` → 401 → silent refresh. Invalid/expired/rotated `rt`
→ 401 (+ family revoke on reuse). Missing CSRF header on a mutation → 403.
All cookie attributes flow through one `cookieOpts(env)` helper.

## Out of scope (YAGNI)

"Log out all devices" UI, per-device session list, remember-me toggle
(14d is the default lifetime), native-app/bearer token mode.

## Risks & mitigation

- **Test-harness cookie migration** is the largest blast radius. Mitigated by
  preserving helper signatures so the change is confined to two helper files;
  TDD; the full suite (now stable via the `resetDb` advisory lock) is the
  gate.
- Dev cookies are not `Secure` (http localhost) — explicitly conditional on
  `NODE_ENV=production` so prod stays `Secure`.
- `Path=/api/auth` on `rt` means only the refresh/logout endpoints ever
  receive it, limiting exposure.
