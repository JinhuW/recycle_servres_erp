---
id: RS-292
title: Facebook fleet scales itself, rolls new versions, and keeps every account's session and device
type: story
status: in-progress
priority: P2
created: 2026-10-18
reporter: jinhu
branch: feat/fb-fleet-identity
pr:
version:
related: [RS-289, RS-291, RS-275]
---

## Ask

> Enable the facebook has the abilities auto scale the worker and update the version of theri workers. But make sure it can keep the session information persistence withot re-login.
>
>
> alwasy keep the same device id without change it, event create a new vm / worker. it should reuse the device id that it used before. A DB can also introduce to tracking this type of information

> No matter the coordinator or the worker it shoud run dependent. either break won't impact each other.

## Context

The fleet is 10 hand-copied worker containers on the homelab VM
(`deploy/docker-compose.homelab*.yml`, one service each), as of
facebook-tracker 0.10.3.

- Adding a worker means copying a compose file, hand-writing
  `secrets.homelab-<x>.env`, adding a proxy variable, and editing three console
  env lists.
- `scripts/deploy.sh` rebuilds `aimm-recycle:latest` but only recreates
  `rs-monitor`. The other nine keep whatever image they were last started from.
- A worker's session is `configs/sessions/<id>/fb_state.json` on its host's
  disk. The coordinator keeps an encrypted copy in `session_snapshots` on every
  save (RS-289), but `GET /v1/session/{id}/restore` has no client, so a lost
  disk is a fresh login.
- There is no device identity. The browser profile is throwaway, the monitor's
  viewport, locale and timezone are Playwright defaults (capture uses another
  viewport), and continuity is only the sidecar user agent plus Facebook's
  `datr`/`sb` cookies.
- The ERP's *Assign to fleet* (`apps/backend/src/routes/facebookPool.ts`
  `/:no/assign`) rewrites a slot's vault account in place with another
  Facebook login. The forced re-login keeps `datr`/`sb`
  (`facebook.py` `DEVICE_COOKIES`), so the new login inherits the old login's
  device: two accounts that read as one machine.

Decisions taken while planning:

- Workers run on Docker hosts. An agent on each host (`rs-fleetd`) reconciles
  containers against the coordinator's desired state; a new VM is another host
  running the agent.
- One worker per ready vault account.
- Upgrades roll one worker at a time, gated on its heartbeat.
- The device belongs to the **Facebook account** (keyed by FB uid), not to the
  worker slot. The session and the egress IP belong to the slot.
- A second VM joins over the homelab LAN: the coordinator and a private
  registry are published on `10.10.10.73`.

## Acceptance criteria

- [x] Every Facebook account has one `device_profiles` row:
      a `device_id`, user agent, screen, viewport, locale, timezone and the
      sealed `datr`/`sb`. It is created once, never regenerated, and applied
      to the browser by whichever worker or host runs that account.
- [x] An account keeps one `datr` from the first Facebook page its worker
      loads, so login attempts that fail do not each look like a new machine.
- [x] Two Facebook logins never share a device. A swap in the ERP quarantines
      the old session and applies the new login's own device cookies.
- [x] A worker whose `/data` holds no session, or the same session gone
      stale, restores the coordinator's snapshot — only one of the same
      account — and does not log in again. A live session of other
      provenance is never replaced.
- [x] Turning on a ready slot (`fleet_enabled`, region and proxy set) starts a
      worker on a host with capacity, with no compose file or hand-written
      env. Turning it off stops the container and keeps its `/data`.
- [x] `rsc fleet release <ver>` upgrades workers one at a time. The next
      worker waits until the current one heartbeats on the new version in a
      state no worse than before. On a timeout, that worker goes back to its
      previous image and the rollout halts; everyone else keeps running.
- [x] Either side can break without the other noticing:
      coordinator or Postgres down → workers keep searching and boot from
      their local cache, and the agent changes nothing; agent down → workers
      keep running; a worker crash-looping → the coordinator is unaffected.
- [x] A second VM on the LAN joins with the `rs-fleetd` compose file and a
      host token.

## Out of scope

- Creating VMs automatically.
- Moving a slot to another host automatically. Moves are started by an
  operator, so one session never runs in two browsers.
- ERP UI for fleet control. It goes through `rsc fleet` and the console.
- A persistent Chromium `user_data_dir`. A profile directory is local to one
  host and would not survive a move; `storage_state(indexed_db=True)` already
  carries cookies, localStorage and IndexedDB.

## Notes

- Plan: `docs/superpowers/plans/2026-10-18-facebook-fleet-autoscale-identity.md`.
- Filed as RS-290 and renumbered: another session took RS-290 and RS-291
  the same day. RS-291 (facebook-tracker 0.10.5, 0.10.6) shipped the plain
  restore of an empty session file, which this ticket's restore extends
  rather than replaces.
- 2026-10-18: va-1 was locked as hacked after six login attempts, each with a
  fresh `datr`. 0.11.0 learned an account's device cookies only from a
  logged-in save, so an account that had never finished a login had no
  device cookies to reuse. The fix records them on the first page, before
  any credentials (first writer wins). The login-attempt ledger, the login
  budget and "no uid, no password login" are follow-ups owned by the RS-291
  session.
- Shipped in four PRs: #724 (device profiles, session restore), #726 (ERP
  sends the uid), #727 (device fixed on the first page) and the fleet agent
  PR (rs-fleetd, scaling, rolling releases, LAN host).
- Verified end to end against local Docker before release, with the
  coordinator on SQLite, rs-fleetd, and stub worker images that heartbeat:
  - two ready slots became two workers, one per agent pass;
  - a release rolled them one at a time, each gated on its heartbeat;
  - turning a slot off removed its container and kept its `/data`;
  - with the coordinator down the agent changed nothing, and it restarted a
    stopped worker from its cached desired state;
  - turning the slot back on returned it to the same host and the same
    `/data`.
- Not deployed by these PRs. Moving the homelab's ten compose workers under
  the agent is the runbook in `trackers/facebook/deploy/README.md` → *The
  fleet agent*, and it waits for an operator to pick the moment.
