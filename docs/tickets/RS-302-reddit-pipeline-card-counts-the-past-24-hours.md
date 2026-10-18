---
id: RS-302
title: Reddit pipeline card counts the past 24 hours
type: story
status: in-review
priority: P2
created: 2026-10-18
reporter: jinhu
branch: rs-tracker-stats-24h
pr:
version: 1.287.0
related: [RS-297, RS-299]
---

## Ask

> This is for past 24 hours

(It came with a screenshot of Monitors ▸ Reddit's "From a post to an alert"
card. The header read "all time", above Poll 21,135 · Evaluate 1,264 · Notify
1,264 and Rejected 19,822.)

## Context

The card reads the tracker's `GET /api/stats` (`trackers/reddit/src/api.ts`),
proxied since v1.284.0 (RS-299). That endpoint groups every row in `posts` by
status with no time filter, and the tracker has no retention job, so the
counts grow forever and say little about how the fleet is doing today.

The window is one cohort: **posts discovered in the last 24 hours**, grouped
by status. Poll counts all of them, Evaluate the ones judged a target, and
Notify the ones alerted. The Waiting, Rejected, Queued and Failed chips count
the same cohort, so the three stages read as a funnel. "Oldest waiting" and
the "Gave up after retries" list stay current-state. They are there to catch a
stuck evaluator, and a window would hide one.

## Acceptance criteria

- [x] `GET /api/stats?since=<ISO 8601>` counts posts by status only where
      `discovered_at >= since`. A bad timestamp is a 400 with the same
      message as `/api/matches`. Without `since` the response is unchanged.
- [x] The ERP proxy forwards `/stats`'s query string to the tracker.
- [x] The page asks for the last 24 hours, and the card header reads
      "past 24 hours" (zh: 近 24 小时).
- [x] Tracker and ERP tests cover the window and the forwarded query.

## Out of scope

- A window picker (24 h / 7 d / all time).
- Windowing "Oldest waiting" or the failed-posts list.
- An index on `posts.discovered_at`: at about 21k rows a scan takes
  milliseconds.

## Notes

- Ship order: the tracker first. An old tracker ignores `since`, so the card
  would show all-time numbers under the new "past 24 hours" label.
