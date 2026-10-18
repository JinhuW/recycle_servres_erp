---
id: RS-299
title: Proxy the Reddit tracker's matches and stats to the ERP
type: story
status: in-review
priority: P2
created: 2026-10-18
reporter: jinhu
branch: feature-backend-for-ui
pr:
version: 1.284.0
related: [RS-297]
---

## Ask

> help me build the backend feature for this UI.

(The message came with a screenshot of Monitors ▸ Reddit's "From a post to an
alert" card on the Evaluate stage. It shows Poll, Evaluate and Notify as "not
counted", and Waiting, Rejected and Oldest waiting as "—".)

## Context

RS-297 (v1.283.0) gave the Reddit page the Facebook fleet layout and left its
backend half as an unchecked follow-up: "the proxy allows
`GET /api/tracker/matches` and `GET /api/tracker/stats`, with tests". The page
already calls both through `trackerApi.listMatches` / `trackerApi.stats`
(`apps/frontend/src/lib/tracker.ts`). The tracker already serves them
(`trackers/reddit/src/api.ts`), and the response shapes match the frontend's
`TrackerMatch` / `TrackerStats` types. But `apps/backend/src/routes/tracker.ts`
allowlists only workers, rules and subreddits, so both calls 404 and the page
falls back to "not counted", "—" and an empty Recent matches aside.

## Acceptance criteria

- [x] `GET /api/tracker/matches` forwards to the tracker's `/api/matches` with
      its query string (`limit`, `since`) untouched, manager-only like the rest.
- [x] `GET /api/tracker/stats` forwards to the tracker's `/api/stats`.
- [x] Backend tests cover both forwards; the allowlist test still rejects
      `/api/tracker/settings`.
- [x] With the tracker reachable, the stage cards show post counts and the
      Recent matches aside lists matched posts.
- [x] The tracker's AGENTS.md allowlist and `docs/FEATURES.md` name the two
      routes.

## Out of scope

- Tracker-side changes: both endpoints already exist with the shapes the page
  reads.
- Settings, requeue and Telegram-test endpoints stay unproxied.
- Making "Batch" live: it is a fixed value in the UI, not read from the tracker.

## Notes

- `/stats` also returns a `subreddits` array the page doesn't read (it gets
  subreddits from `/subreddits`). It passes through untouched, the same as
  every other proxied body.
