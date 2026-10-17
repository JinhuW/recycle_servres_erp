---
id: RS-262
title: Count every stage of the search-to-alert funnel
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/account-pool-datasources
pr:
version: 1.264.0
related: []
---

## Ask

> fix all the datasource of this:
> [Image #1]
>
> I hope the dashboard can track these data as well.
> make sure keep the overall system efficient.
> plan first and go ahead and start the implmentation without asking

(Image #1: the Monitors ▸ Facebook "From a search to an alert" card, where
seven of the nine stages read "— not counted yet"; only AI rating and Telegram
alert had numbers.)

## Context

`FlowCard` (`apps/frontend/src/pages/desktop/FleetFlow.tsx`) draws the nine
stages from `flowCounts` in `lib/fleetView.ts`. That function only had
`/v1/stats/reviews` to read, and the coordinator's `review_stats` table only
kept two counters per worker per UTC day: `reviewed` (fresh model verdicts)
and `alerted`. Every other stage was a worker event that only went to
OpenSearch.

The homelab workers send alerts straight to Telegram and report each sent
message to the coordinator (`/v1/alerts/telegram`). Sharded workers post their
matches to the coordinator (`/api/v1/listings`), which dedupes them and sends
through its outbox. So the last two stages are counted on the coordinator, and
the first seven on the worker.

## Acceptance criteria

- [x] `review_stats` gains `searches`, `cards`, `title_pass`, `opened`,
      `keyword_pass`, `fresh`, `coordinated` and `sent` (SQLite and Postgres,
      added in place on existing databases).
- [x] `POST /v1/stats/reviews` accepts the worker counters; old workers that
      send only `reviewed`/`alerted` still work.
- [x] The coordinator counts a match as `coordinated` when ingest finds it new
      or changed, or when a direct-send worker reports its alert. It counts
      `sent` for each listing alert the outbox delivers and each reported
      direct-send alert.
- [x] `GET /v1/stats/reviews` returns daily fleet sums of every counter.
- [x] The vendored monitor buffers its stage counts and sends them once per
      search page, which replaces the per-verdict POST.
- [x] All nine stage tiles on the card show today's number. Against an older
      console, the alert tile falls back to `alerted` and the rest still read
      "not counted yet".

## Out of scope

- Per-worker or per-city funnel breakdowns, and a history chart of the funnel.
  The rows are per worker per day, so either can be built later from the same
  table.
- Backfilling past days from OpenSearch.

## Notes

- Buffering on the worker trades at most one search page of counts (lost if the
  process dies mid-page) for far fewer requests than the old one-POST-per-verdict.
- Coordinator-side counts land in `review_stats` under the reporting worker. The
  outbox has no worker, so those land under the reserved id `coordinator`. Only
  fleet-wide sums are read.
