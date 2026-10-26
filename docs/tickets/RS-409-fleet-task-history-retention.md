---
id: RS-409
title: Fleet task history retention
type: task
status: done
priority: P2
created: 2026-10-26
reporter: jinhu
branch: fleet/task-retention
pr: "#921"
version: 1.358.0
related: [RS-394]
---

## Ask

> complete all remaining

> Add retention for the ERP fleet's task history (RS-394). Today fleet_tasks and fleet_task_events grow forever (about 250–750 tasks/day once the full catalog runs, several events each); the scheduler's quarantine/familiar/last-done reads and the Analysis tab's history queries get slower as they grow.

(The owner's approval, then the brief it approved.)

## Context

Part of the ERP fleet task queue (RS-394). Every finished, cancelled or
expired task and its events stay in `fleet_tasks` / `fleet_task_events`
for ever; several scheduler and pick reads scan that history.

## Acceptance criteria

- [x] `fleet_settings` key `retention_days` (default 90, 30..730), validated
  like the other numeric keys and editable under **Rules**.
- [x] The scheduler purges terminal tasks (done, cancelled, expired) older
  than the window, with their events and archived attempts, at most once an
  hour per process, 5,000 tasks per run, one instance at a time.
- [x] Ready and leased tasks are never touched.
- [x] What the rules read further back than the window survives: the newest
  finished search per city and item, and the latest verify-slug verdict per
  city. The window never drops below `familiar_days`.

## Out of scope

Archiving purged rows elsewhere; the long-term per-day minutes history
(`fleet_minutes` only serves today's budget).

## Notes

What each rule reads, and how retention keeps it:

| Rule | Reads back | Kept by |
| --- | --- | --- |
| Cadence, retime, Cities tab "last search" | newest done search per (city, item), unbounded | keep that row regardless of age |
| `slugConfirmed` (enable a city) | latest verify-slug verdict per city, unbounded | keep that task and its events regardless of age |
| Familiar city (pick) | `familiar_days` (0..90) | window clamped to at least `familiar_days` |
| Quarantine evidence | `quarantine_hours` (≤ 720 h = 30 d) | lower bound 30 |
| Probe interval, round start, verify backoff | ≤ 7 d | lower bound 30 |
| City log | `hours` ≤ 720 = 30 d | lower bound 30 |
| Budget (`fleet_minutes`) | today (UTC) | attempts older than the window go with their task |

No rule needs the newest task per (account_no, city): the familiar test and
the quarantine evidence are both windowed, so clamping covers them.
