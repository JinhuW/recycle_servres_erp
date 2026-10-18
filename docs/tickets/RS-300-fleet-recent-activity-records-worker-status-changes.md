---
id: RS-300
title: Fleet Recent activity records worker status changes
type: story
status: in-review
priority: P2
created: 2026-10-18
reporter: jinhu
branch: feat/fleet-activity-status-changes
pr:
version: 1.285.0
related: []
---

## Ask

> [Image #1]
>
> The recent activities shoudl capture when the woker status get changed.

![Fleet tab: three workers on Needs attention, the feed shows only backups and sweeps](assets/RS-300-fleet-activity.png)

## Context

Monitors ▸ Facebook ▸ Fleet's Recent activity (`ActivityAside` in
`FleetWorkers.tsx`) is rebuilt in the browser by `fleetActivity()`
(`lib/fleetView.ts`) from the timestamps the fleet doc happens to carry: each
worker's latest search, listing and session backup, a dead worker's last
heartbeat, and the open checkpoints. It cannot show a status change because
nothing records one. The coordinator overwrites `workers.state` on every
heartbeat (`rs_coordinator/routers/health.py`), works liveness out on read
(`health.py`, live under 2 h, stale under 6 h, dead after), and sends its
state-change alerts straight to Telegram without keeping them. So when three
workers flipped to *Needs attention · Session expired*, the feed only showed
backups and sweeps.

The ERP stores nothing about the fleet (it proxies rs_console), so the log has
to live in the coordinator and reach the ERP through `/v1/fleet`.

## Acceptance criteria

- [x] The coordinator appends a row when a worker's reported state changes,
  and when its liveness crosses live → stale → dead or comes back live,
  stamped at the real crossing time (last heartbeat + 2 h / + 6 h, the beat
  that revived it).
- [x] Existing workers produce no burst of entries on deploy; a retired
  worker's silence is not logged.
- [x] `GET /v1/stats/status-changes` returns the last 7 days, newest first;
  rs_console puts them in `/v1/fleet` as `status_changes`.
- [x] Recent activity lists each change ("went stale", "went offline", "is
  reporting again", "needs attention: Session expired", "is healthy again")
  with the dot of the status it moved into.
- [x] The worker page's History shows the same changes for that worker.
- [x] Against a console without `status_changes`, the feed is unchanged (keeps
  "stopped reporting").
- [x] Both database backends are covered by tests; the zh strings exist.

## Out of scope

- Session-expiry-window crossings (≤ 14 days left) as entries. Fleet sessions
  report about a year left, and an expired session arrives as the
  `SESSION_EXPIRED` state, which is logged.
- "Cleared a checkpoint" entries from resolved challenges: an ERP-only
  follow-up (the page fetches open challenges only).
- A per-worker status timeline beyond the History list.

## Notes

- The coordinator side is under `[Unreleased]` in `trackers/facebook/CHANGELOG.md`
  and is not released here. The fleet runs 0.12.4, cut on the local branch
  `release/facebook-tracker-0.12.4`, which had not reached `dev` (whose
  `VERSION` still read 0.12.2). Releasing from this branch would have
  collided with that branch's 0.12.3 and 0.12.4 tags. Until the tracker is
  released and deployed, the ERP shows the feed as before.
- Verified end to end against a local SQLite coordinator and rs_console, with
  the local ERP pointed at them. Each change kind rendered with its dot, and
  the worker page's History showed the same changes.
- Facts, not chips, are logged: the coordinator records raw `state` and
  liveness changes, and the ERP phrases them. The chip itself is the ERP's
  `fleetStatus()`, which a Python copy would drift from.
