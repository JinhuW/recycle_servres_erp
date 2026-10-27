---
id: RS-432
title: Dev's Fleet page reads prod's fleet live
type: bug
status: in-progress
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/fleet-mirror-live
pr:
version:
related: [RS-427]
---

## Ask

> debug why in the dev.
> [Image #1]
> There is no healthy worker?

> 1

## Context

The screenshot is dev's Fleet page: 14 workers, 0 healthy, 11 Offline with
"beat 2 h 25 min ago". Nothing is broken. Since RS-427 (17:44 UTC on
2026-10-27) the fleet runs on prod and dev's backend has `FLEET_ROLE=mirror`.
No agent or worker reports to dev anymore: the agents were re-pointed at prod,
and the dev Cloudflare Worker forwards the rest. Dev's `fleet_*` rows are
therefore a frozen copy. The page derives a worker's state from heartbeat age,
so every row ages into Offline.

`SYNC_KEEP_FLEET=0` is already set on dev's db-sync, so the 04:00 UTC prod→dev
copy will bring prod's fleet over. That is still a snapshot, and within hours
of each sync the page would read "0 healthy" again.

The "1" chose the first of two fixes offered: the mirror forwards the Fleet
page's reads to prod, rather than keeping the snapshot and labelling its age.

## Acceptance criteria

- [x] On prod, a GET under `/api/fleet` that a manager may read also accepts an OAuth bearer with the new `fleet:read` scope. Writes still need a manager session, and host and worker routes are unchanged.
- [x] Dynamic client registration never hands out `fleet:read`. A manager can grant it to a service client in Settings → Connectors.
- [x] With `FLEET_ROLE=mirror` and `FLEET_MIRROR_URL` / `FLEET_MIRROR_CLIENT_ID` / `FLEET_MIRROR_CLIENT_SECRET` set, a manager's GET under `/api/fleet` (except `/health` and the VNC socket) is answered with prod's response. The caller is still checked as a dev manager first.
- [x] The client_credentials token is reused until shortly before it expires.
- [x] When prod can't be reached, the read answers 502 rather than the stale copy.
- [x] Without those variables, the mirror reads its own copy as before.
- [ ] Dev's Fleet page shows prod's workers with heartbeats seconds old.

## Out of scope

- The Account Pool page on dev (`/api/facebook-pool`): still the nightly copy.
- VNC through the mirror.
- Labelling the snapshot's age instead (the other option offered).

## Notes

Plan: `~/.claude/plans/crispy-roaming-rain.md`. Rollout needs a dev→main
release, a `fleet:read` service client minted on prod, and the three variables
on Railway dev `backend`. No worker container is touched, so there is no
Facebook login.
