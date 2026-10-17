---
id: RS-261
title: Facebook fleet tab: redesign to the pool's layout, worker pages
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-page-redesign
pr: 669
version: 1.263.0
related: [RS-164, RS-254, RS-259, RS-260]
---

## Ask

> Based on the existing design of erp facebook tracker.
> https://claude.ai/artifact/2y8gqEQ6Gjsj5uQoDpd6Xh
> Pls help me refine the design of the fleet page. The goal of it is for our employee's facebook can keep tracking the new post in the facebook market. But keep in mind, do not break the community rule.

> i hope the fleet page can keep consistence with the accoint pool page. like the headers and other UI

> The purpose here is mainly use the woker to track the marketplace and see if anything we are interetsed show up.
> It will first filter by the keywords, the by the AI sementic understanding.
>
> It will be great to use a flow UI to display this better. But pls use the code to confirm how the backend code is working now.

> This page is manager only.
>
> update the page to access each woker detail, the deisgb of this [Image #4] is great

> pls reduce the link to one.
> Only the eye can access to it.
>
> All edit move to the detail oage.

> remove this [Image #13]
> from the fleet + account pool

> start the UI implementation

## Context

The design was iterated as an artifact (link above, version 15). The Account
pool tab already shipped (v1.261.0 page, v1.262.x backend, RS-259/RS-260), so
this ticket is the Fleet tab at **Monitors ▸ Facebook ▸ Fleet** (`/fleet`).

Before this, the Fleet tab (`DesktopCoordinator.tsx` + `FleetAccounts.tsx`)
stacked KPI tiles, a Needs-a-human card, two account tables, phrases and
settings cards, a coverage map, a review chart, the filter-prompt card and a
clicks placeholder, all fed by the `/api/coordinator/*` proxy. The design
brings it into the pool tab's chrome and adds a picture of how a listing
becomes an alert, confirmed against the monitor code (`facebook.py` search →
`get_listings` → `check_listing` before and after the page visit;
`monitor.py` already-notified skip, `evaluate_by_ai`, unit and rating gates;
coordinator dedupe by item id, outbox, Telegram topic by counted units).

The design also assumes things the backend does not serve yet: per-worker
search counts and sweep times, per-stage funnel counts, a write path for
`master.toml`, an OpenRouter model catalog, and employee-owned accounts. The
only fleet writes today are credentials (RS-254), Re-login and checkpoint
resolve. This ticket ships the layout on real data and keeps edits to those
three; the rest is phase 2.

## Acceptance criteria

- [x] Fleet tab: a status legend (Live, Stale, Needs attention, Offline) with
      counts; clicking a state filters the table. The search box filters by
      worker, login, region and city.
- [x] The workers table fits its column without a horizontal scroll: fold
      chevron, worker (login, region), state chip with flags, last search,
      session days left, alerts in 7 days, eye. The fold shows the worker's
      cities with their 7-day alerts and its pacing, read-only.
- [x] The eye is the only route to a worker's page (`/fleet/worker/:id`);
      rows and the legend do not navigate.
- [x] A Recent activity aside, as tall as the workers card, scrolls; it is
      derived from heartbeats, searches, listings and checkpoints.
- [x] A flow card shows Search → Result cards → Title gate → Open the listing
      → Keyword gate → New to us → AI rating → Coordinator → Telegram alert,
      each with what the code does, its config from `/v1/fleet` and a count
      where one exists (reviewed and alerted today); stages with no count
      show "—".
- [x] A worker page in the pool's credential-card style: Facebook login and
      user id, session expiry, browser and backup, proxy, cities, pacing,
      stored secrets, build; open checkpoints with their capture and Mark
      resolved; Watch browser, Re-login and Edit credentials.
- [x] The Watch page's back link returns to the worker's page.
- [x] The Fleet tab no longer shows the KPI tiles, the Needs-a-human card,
      the second accounts table, the phrases and settings cards, the coverage
      map, the review chart, the prompt card or the clicks placeholder; their
      content lives in the flow card, the fold and the worker page.
- [x] The manager's Account pool tab no longer shows the key-tag rail; its
      legend stays.
- [x] Every new string has English and Chinese; the Fleet tab stays
      manager-only.

## Out of scope

Phase 2, each needing backend work first:

- Editing stages, fleet rules, cities and pacing, and the OpenRouter model
  picker: needs a console endpoint that writes `master.toml` / `fleet.toml`
  and runs `rsc gen-configs`.
- Employee-owned "watcher" accounts, enrolment, and the rules card built on
  them (home IP, no proxy, owner pause/withdraw).
- Pause, ping and remove for a worker.
- Per-worker searches and budget, and the day strip of a sweep.
- Per-stage funnel counts: the worker events exist in OpenSearch but are not
  aggregated on the coordinator.

## Notes

- The legend is Live / Stale / Needs attention / Offline, not the design's
  Watching / Resting / Paused / Checkpoint. `last_search_at` is stamped at the
  start of a sweep that runs for hours and the heartbeat's `status` is free
  text, so nothing the coordinator serves says whether a worker is mid-sweep
  now, and there is no pause.
- Recent activity is rebuilt from timestamps (last search, last listing,
  session backup, last heartbeat of a dead worker, open checkpoints); the
  coordinator keeps no event log the ERP can read.
- Purchasers keep the pool's key-tag rail: it is their only way to take a
  particular account rather than the next in line. The ask came from the
  manager's view.
- `trackers/facebook/rs_console/static/fleet.css` still carries the old card
  classes for the console's own dashboard; the ERP copy dropped them. The
  tracker file was left alone, since any change under `trackers/facebook/`
  blocks its deploy until a tracker release.
- Verified against a mock `/v1` facade with six workers in every state: the
  table fits at 1280 and 1440 px, the eye and the Watch back link route
  correctly, no request fails after sign-in. The Chinese strings were not
  rendered on screen.
- Plan: `~/.claude/plans/elegant-gliding-breeze.md` (session-local).
