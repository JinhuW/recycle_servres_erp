---
id: RS-141
title: "Edge hardening: real client IP and browser security headers"
type: bug
status: in-progress
priority: P1
created: 2026-10-02
reporter: jinhu
branch: fix/edge-headers
pr:
version:
related: [RS-130, RS-134]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

This is Batch 3a of the approved plan,
`docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`.

## Context

- **The backend never sees the real client IP.** In production, every
  `login_attempts.ip` from the last 30 days is a Cloudflare egress address:
  24 distinct addresses (104.22.x, 172.68.x, 162.159.x) shared across all users.
  The Worker sets `X-Forwarded-For` from `CF-Connecting-IP`, but Railway's edge
  rewrites the `X-Forwarded-*` headers, the same trap that made
  `X-Public-Host` necessary. As a result, every per-IP limit keys on
  Cloudflare's servers, including the public-form 5/min limiter.
- **M9: the Worker serves no browser security headers.** The move from
  Caddy to the Cloudflare Worker dropped the CSP, `X-Frame-Options`, `nosniff`,
  `Referrer-Policy` and `Permissions-Policy`. Only HSTS and cache rules
  survived in `_headers`.

## Acceptance criteria

- [ ] Every proxied `/api` request carries `X-Client-IP` set from
      `CF-Connecting-IP`.
- [ ] Every page and asset response carries `X-Frame-Options: DENY`,
      `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, a
      `Permissions-Policy` that allows the camera on self only, and HSTS.
- [ ] The CSP ships as `Content-Security-Policy-Report-Only` for this release.
      It reports nothing during login, PO photos, QR/RAM-sheet scanning, the
      desk-scanner bridge, downloads, PWA registration and OAuth consent.
- [ ] `index.html` carries a `csp-rev` marker, so a policy change also
      refreshes the service-worker precache.

## Out of scope

- Enforcing the CSP. That follows in a later release, after the report-only
  release reports nothing.
- Backend use of `X-Client-IP`. That is Batch 3b.

## Notes

Both R2 origins are in the one policy, because the dev database is a nightly
copy of prod and shows prod's image URLs.
