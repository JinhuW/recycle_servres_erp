---
id: RS-437
title: Fix the dev-to-main review findings before releasing
type: bug
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/barb
pr: https://github.com/JinhuW/recycle_servres_erp/pull/968
version: 1.373.1
related: []
---

## Ask

> /code-review high from dev to main. fix all issues and release to prod.

## Context

A high-effort review of the five commits on `dev` not yet on `main`
(RS-432 to RS-436, v1.371.1 to v1.373.0) found ten issues, most in the dev
mirror's live reads of prod's fleet (RS-432) and one in the release order of
the `fleet_cities.pinned` drop (RS-435).

## Acceptance criteria

- [x] A mirror read prod can't answer (network, timeout, token refused, 5xx,
      or the app-wide 404 of a route prod's older release lacks) serves the
      local copy instead of a 502.
- [x] Only a refused token (`invalid_token`) clears the cached token, and only
      once; any other upstream 401/403 goes back as it came.
- [x] Reads that find the token cache cold share one mint; a token without
      `expires_in` is still cached.
- [x] A forwarded answer keeps prod's headers (`X-Fleet-Truncated`, `ETag`).
- [x] `/health` reports `mirror_live` only when prod hands over a token.
- [x] `mirrorGate` forwards through `managerSession` with no hand-chained
      middleware or casts.
- [x] A user-bound `fleet:read` token is refused on prod; only service
      clients read the fleet by bearer.
- [x] A running worker whose slot a manager parked reads Parked on the Fleet
      tab.
- [x] `fleet_cities.pinned` is not dropped in the release that stops writing
      it, and a cached page that still sends `pinned` is not refused.
- [x] `docs/DATABASE.md` matches the schema.

## Out of scope

Dropping `fleet_cities.pinned`: it goes in a later release, once no running
release writes it.

## Notes

Migration 0216 had already run on dev, so dev's table lacks the column until
the nightly prod→dev sync or the later drop; no code reads it there.
