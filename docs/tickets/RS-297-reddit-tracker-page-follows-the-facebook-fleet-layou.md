---
id: RS-297
title: Reddit tracker page follows the Facebook fleet layout
type: story
status: in-review
priority: P2
created: 2026-10-18
reporter: jinhu
branch: reddit-tracker-fleet-layout
pr: "#737"
version: 1.283.0
related: []
---

## Ask

> Pls follow the facebook marketplace UI and redesign the UI for the reddits tracker UI.

> no backend yet. design the UI first

## Context

Monitors ▸ Reddit (`/tracker`, `apps/frontend/src/pages/desktop/DesktopTracker.tsx`)
was three stacked generic cards: alert rules, subreddits, then a fleet table.
Monitors ▸ Facebook (`/fleet`, `DesktopCoordinator.tsx` + `FleetWorkers.tsx` +
`FleetFlow.tsx`) is built around a status legend, a workers table beside an
activity aside, and a "From a search to an alert" pipeline card where the
rules are edited. The two monitors should read as one product, so the Reddit
page takes the Facebook page's layout and its `fp-*` / `ff-*` styles.

The tracker already serves `/api/matches` and `/api/stats`
(`trackers/reddit/src/api.ts`), but the ERP proxy (`apps/backend/src/routes/tracker.ts`)
does not allow them yet. The UI calls them and degrades to empty states
until the proxy does.

## Acceptance criteria

- [x] The page head reads "Monitors / Reddit" over the title "Reddit fleet", like the Facebook head.
- [x] A status legend shows Live / Stale / Dead worker counts; clicking one filters the table, clicking it again clears the filter.
- [x] The workers table uses the Facebook table style: worker id with role and start time underneath, a status chip with a "Last heartbeat …" note, the poll / evaluate / notify ages, and Remove on dead rows. Infinite scroll and the 30 s refresh still work.
- [x] A "Recent matches" aside beside the table lists the newest matched posts (subreddit, title, price, age), each linking to the Reddit post.
- [x] A "From a post to an alert" card shows Poll → Evaluate → Notify with post counts from `/api/stats`. Poll holds the subreddit table and the add form; Evaluate holds the alert rules (new, edit, toggle, delete); Notify shows delivery facts and the failed count.
- [x] When matches or stats can't be fetched, those parts show "—" or an empty state and the rest of the page keeps working. The 501 "not configured" state is unchanged.
- [x] Follow-up (backend, RS-299, v1.284.0): the proxy allows `GET /api/tracker/matches` and `GET /api/tracker/stats`, with tests.

## Out of scope

- The proxy change, for now (the second Ask line). Tracker-side changes.
- Tracker settings and requeue endpoints (still not proxied).
- A worker detail page like the Facebook one: Reddit workers have no browser to watch and no per-worker config.
- A search box: the table loads by page, so a search would only cover the rows already loaded.
- The mobile app.

## Notes

Plan: reuse the Facebook page's classes instead of a new look; the brief pins
the visual direction.

- Reviewed against a local stub of the tracker API, with matches and stats
  routed to the stub in the browser, since the proxy doesn't forward them.
- Legend counts are three `limit=1` worker listings, one per status. The
  tracker counts with SQL, so no rows are shipped just to count them.
- The ERP has no dark theme, so there is no dark mode to check.
