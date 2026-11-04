---
id: RS-526
title: Release-review findings before the v1.418 prod cut
type: bug
status: done
priority: P2
created: 2026-11-04
reporter: jinhu
branch: JinhuW/release-review-1-418
pr: 1085
version: 1.418.1
related: []
---

## Ask

> /code-review dev to main, release it after fixing all issues.

## Context

The review of `origin/main...origin/dev` (RS-521 to RS-525, v1.415.0 to v1.418.0)
reported ten findings and one more cut by its cap. None crashes production or
causes a Facebook login; they are wrong evidence or misleading UI. Each was
checked against the code before it was fixed.

## Acceptance criteria

- [x] A timing report with `loadEvent` 0 stores no `load` sample, and keeps its TTFB and LCP.
- [x] `/api/perf/versions` orders ties in the last hour by later start, then higher version.
- [x] Only hostAuth `/api/fleet/hosts` routes, fleet worker routes, memtrade's push routes, `/api/health` and `/metrics` count as machine traffic.
- [x] `/api/perf/compare` reads through `allLimited`.
- [x] A load on a path no view claims reports `other`, while the shell still lands on Home.
- [x] Changing the compared versions clears the old rows; a failed compare says so in its own card.
- [x] The nightly copy keeps dev's `perf_rollups` and drops prod's.
- [x] `erpProxyBehind` treats a dropped default port and host case as the same proxy, and still names a real move.
- [x] The Watch page shows the same "still running through" line as the worker page.
- [x] Change proxy's `exists` refusal closes the dialog and rereads, as `proxy_changed` does.
- [x] Any later price write on Box Check removes the line's "Priced from" note.

## Out of scope

Fixing `proxyWithoutLogin` to keep the port: exits already stored in the database
would still need the same reading, so the comparison is what changes.

With `SYNC_KEEP_FLEET=0` dev takes prod's `perf_rollups` along with its fleet.
That is a later decision for when the fleet runs on prod.

## Notes

The Box Check fix sits in `savePrice`, not only in From sell order, because a
typed price left the same stale note.

The timing rows dev flushes between its redeploy and the restore are lost, a few
minutes a night at about 04:00 UTC.
