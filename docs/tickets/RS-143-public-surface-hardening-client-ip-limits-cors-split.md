---
id: RS-143
title: "Public-surface hardening: client-IP limits, CORS split, intake limits, login throttle, consent host"
type: bug
status: in-progress
priority: P1
created: 2026-10-02
reporter: jinhu
branch: fix/public-surface
pr:
version:
related: [RS-130, RS-134, RS-141]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

This is Batch 3b of the approved plan,
`docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`, covering
review findings M2, M3, M4, M5, M6 and M10. Decisions recorded with the plan:
connectors show the redirect host plus an "unverified" badge, with no approval
gate; form spam is handled by budgets and a purge, with no CAPTCHA.

## Context

- **M10: per-IP limits keyed on Cloudflare.** Four copies of an IP extractor
  read the first `X-Forwarded-For` entry, which Railway's edge rewrites to a
  Cloudflare egress address. RS-141 (v1.194.2) makes the Worker send the
  visitor's address as `X-Client-IP`. The in-memory limiter also never forgot
  a key, so a scan of addresses grew it without bound.
- **M6: the marketing sites shared the app's credentialed CORS.** ram4cash.com
  and recycleservers.com were in `CORS_ALLOWED_ORIGINS`, so they got
  `Access-Control-Allow-Credentials: true` on every `/api` route, though they
  only post two cookie-less forms.
- **M4: intake could be made to decode huge images.** The intake form shared
  the 50 MiB upload cap, had no per-photo cap, and sharp's pixel limit was not
  set. A small PNG with a huge canvas could pin the process.
- **M5: no ceiling on form volume.** A rotating-IP spammer could fill R2 and
  the submissions table without bound, and spam/archived rows were never
  removed.
- **M3: the login throttle raced.** Twenty parallel guesses all read "0
  failures" before any of them wrote one, so the 5-attempt lock let through as
  many guesses as arrived at once. bcrypt also ran unbounded, and the OAuth
  token endpoint had no limiter in front of the secret compare.
- **M2: consent showed only the self-chosen name.** Any DCR registrant can
  call itself "Claude". The consent page did not say where the code would be
  sent or that nobody had vetted the name.

## Acceptance criteria

- [ ] Every per-IP limit and every stored IP comes from one `clientIp()`
      helper. It reads `X-Client-IP` first, then the first `X-Forwarded-For`
      entry, then `X-Real-IP`. Limiter keys group IPv6 by /64.
- [ ] The in-memory limiter drops expired keys and never holds more than
      50,000.
- [ ] `/api/public/intake` and `/api/public/quote` answer the four site origins
      without credentials. Those origins get no CORS headers on any other
      route, and the SPA keeps its credentialed CORS.
- [ ] The intake body is capped at 25 MiB and each photo at 15 MiB (413). A
      photo over 40 MP, or one that cannot be decoded, gets a 400. At most two
      shrinks run at once, and a public caller that waits too long gets a 503.
- [ ] Past 300 submissions or 2 GB of photos in a UTC day, both forms answer
      429 with `Retry-After`. Both limits are workspace settings.
- [ ] A daily job deletes spam and archived submissions older than 30 days,
      together with their R2 photos. A row whose photo delete fails is kept.
- [ ] 20 parallel bad logins for one email record at most 5 failures, and the
      rest get a 429. No pending rows are left over. 30 failures from one real
      client IP within 15 minutes lock that IP across emails. That limit is
      skipped while `X-Client-IP` is absent.
- [ ] At most 4 bcrypt operations run at once. A caller that queues for longer
      than 5s gets a 503 with `Retry-After`.
- [ ] `/oauth/token` and `/oauth/revoke` refuse past 60 calls a minute per
      client, and past 120 per client IP.
- [ ] The consent page names the redirect host and marks a self-registered
      client "Unverified". The connectors list shows each client's redirect
      URIs and the same badge.

## Out of scope

- CAPTCHA on the public forms, and an approval gate for self-registered
  connectors. Both were declined in favour of the budgets and the badge.
- Removing the site origins from prod `CORS_ALLOWED_ORIGINS`. That is an ops
  step taken after this release reaches prod, with the user's go-ahead.

## Notes

- Migration 0147 drops `NOT NULL` from `login_attempts.success`, so an attempt
  can be reserved before bcrypt runs. It also adds `ip_key` and its index.
- The per-IP login budget is deliberately off when `X-Client-IP` is missing.
  Without it, every request looks like it comes from a handful of Cloudflare
  addresses, and one attacker would lock everyone out.
