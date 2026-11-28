---
id: RS-619
title: Fleet worker session saves over 1 MiB are refused with 413
type: bug
status: in-review
priority: P1
created: 2026-11-28
reporter: nightly-railway-inspection
branch: fix/fleet-session-body-cap
pr:
version: 1.484.1
related: [RS-419]
---

## Ask

Filed by the nightly Railway inspection routine from the `backend` logs of
deployment `a6759900` (v1.482.1), 35 lines between 2026-11-27 11:36:42 and
2026-11-28 04:37:53 UTC, one every 30 minutes:

> {"level":"info","version":"1.482.1","message":"request","method":"PUT","path":"/api/fleet/worker/session","status":413,"ms":1,"error":"Payload too large"}

## Context

Since facebook-tracker 0.14.8 (RS-419) a worker's session save carries the
browser's whole Playwright `storage_state`, IndexedDB included. Facebook's
IndexedDB grows as a session ages, and one worker's save crossed the global
1 MiB JSON cap in `apps/backend/src/index.ts`. The cap rejects it before auth,
so the handler never runs, the pool row keeps an older session, and the next
boot of that account restores it. A stale restore is how a worker ends up
logging in again, which risks a checkpoint.

## Acceptance criteria

- [x] `PUT /api/fleet/worker/session` accepts a body up to 16 MiB.
- [x] Every other JSON route keeps the 1 MiB cap, the other fleet worker
      routes included.
- [x] `tests/body-limit.test.ts` covers both.

## Out of scope

Trimming the worker's IndexedDB export on the tracker side. The ERP has to keep
accepting what the images in the field send.

## Notes

The 413 comes before `workerAuth`, so the log line names no worker or
account. The 30-minute cadence matches a single worker's save loop.
