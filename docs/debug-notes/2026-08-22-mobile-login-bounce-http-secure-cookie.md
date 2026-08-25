# 2026-08-22 — Mobile login bounced back to the login screen: http page + Secure cookies

## Symptom

On a phone, dev login reached the role picker and then dropped straight back
to the login screen. Desktop and every scripted repro (curl, emulated mobile
Chrome, real WebKit via Playwright) worked, so it looked device-specific.

## Log signature (Railway backend / `wrangler tail`)

```
POST /api/auth/login    200        ← credentials fine, Set-Cookie sent
GET  /api/lookups       401  0ms
POST /api/auth/refresh  401  0ms   ← sub-millisecond = no cookie reached us at all
GET  /api/notifications 401  0ms
POST /api/auth/logout   200        ← the SPA's auth:unauthorized handler giving up
```

The 0–1ms 401s are the tell: the auth middleware exits before any DB work
when there is no cookie. A present-but-invalid refresh token costs a few ms
(hash + lookup). **Sub-millisecond 401 ⇒ the cookie header was absent.**

`wrangler tail --format json` was the decisive instrument — it shows each
request's headers (cookie value redacted but presence visible), User-Agent,
and `cf.httpProtocol`, with no code change or deploy. The failing phone's
requests stood out immediately: `"url": "http://inventory-dev…"`,
`cf-visitor: {"scheme":"http"}`, HTTP/1.1, empty `tlsVersion`, no cookie
header ever.

## Root cause

Cloudflare accepted plain-http requests for the Worker's custom domains and
the Worker served the full app over them — no Always-Use-HTTPS on the zone,
no redirect in `worker.js`. The phone had the site open as
`http://inventory-dev.recycleservers.com` (typed/bookmarked; Chrome on iOS
does not force https the way desktop Chrome does).

The backend (NODE_ENV=production) marks `at`/`rt` cookies `Secure`. A browser
**silently discards a Secure cookie delivered over http** — the login POST
itself still returns 200 with the user object. The SPA then swallows the
post-login `loadLookups()`/`loadWorkspaceSettings()` failures by design
(`lib/auth.tsx`), sets the user, and shows the role picker; the first
background call (`/api/notifications`) 401s, the refresh 401s,
`auth:unauthorized` fires, and the shell logs out → back to Login. No error
is ever surfaced.

## Fix

`deploy/cloudflare/worker.js` now 308-redirects any `http:` request to
`https:` before doing anything else, and `apps/frontend/public/_headers`
adds host-only HSTS (`max-age=31536000`) so repeat visitors skip even the
first insecure hop.

## Traps for next time

- **"Login succeeds but nothing after it is authenticated" ⇒ check the page's
  scheme before anything else.** Secure-cookie-over-http produces exactly
  this shape, and nothing logs an error anywhere — not the backend (it did
  set the cookie), not the browser console of a remote user.
- Response-latency on auth 401s distinguishes *missing* cookie (0–1ms) from
  *rejected* cookie (several ms). It's visible in the plain Hono request log.
- A repro that "works everywhere you try it" is a hint that the difference is
  in the client's *entry point* (scheme, host, installed PWA, webview), not
  the client's engine. All the scripted repros typed `https://` and so could
  never hit it.
- The role-picker-then-bounce shape is the generic signature of "user object
  arrived in the login response body, but the session cookies are dead" —
  `login()` succeeds on the body alone and swallows the sibling fetch
  failures on purpose.
