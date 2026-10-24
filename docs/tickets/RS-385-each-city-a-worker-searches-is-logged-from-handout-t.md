---
id: RS-385
title: Each city a worker searches is logged from handout to result
type: story
status: in-progress
priority: P2
created: 2026-10-23
reporter: jinhu
branch: fb-city-log
pr:
version:
related: [RS-379, RS-372, RS-370]
---

## Ask

> I would like to build an log for each each cities. for each worker, once it finish the cities. it should log an brief report of it results

and, while it was being planned:

> it will be great to have a full lifecycle logs not just finish

## Context

Since RS-372 (facebook-tracker 0.13.14), enrolled workers take their cities
from the coordinator's queue. Since 2026-10-24 00:07 UTC, that is every
healthy worker. Nothing keeps the story of one city on one worker. The
coordinator holds pieces of it:

- **The lease** (`city_leases`): when the city was handed out and when the
  worker's next ask closed it.
- **One `city_searches` row per search page**, with cards, opened, reviewed and
  alerted, but not the phrase that was searched.
- **`alert_messages`**, with worker, item, city and phrase, but not what the
  listing was.

The worker's own log has a `[Queue]` line at handout and a `[Search]` line per
phrase. Nothing says "Miami for server_ram: 3 searches, 84 cards, 1 alert,
6 min, finished". Nothing says why a city stopped part-way, or that a city
handed out was never finished because the worker parked or went silent.

## Acceptance criteria

- [x] For every city a worker searches, the coordinator logs:
      - its start: handed out by the queue (home, familiar or other city), or
        taken from the worker's own list;
      - every search page: the phrase, cards, title passes, opened, keyword
        passes, fresh, AI-reviewed and alerted;
      - every alert sent: the title, price, score and link;
      - its end, which is one of:
        - finished, with a brief report: searches, cards, opened, reviewed,
          alerts, empty searches, minutes;
        - stopped, with the reason;
        - given back, because the worker parked or restarted;
        - expired, because the worker went silent.
- [x] The worker's own log reads the same way: a `[City]` line when a city
      starts, and one when it finishes or stops, with the brief report.
- [x] `rsc queue log` prints one line per visit, newest first.
      - It filters by worker, city, item and hours.
      - `--events` adds each visit's timeline.
- [x] The ERP worker page has a "City log" card for the last 24 h.
      - Each visit is one row: time, city and item, searches, cards, opened,
        reviewed, alerts, and the outcome.
      - A row opens to its timeline.
- [x] In the round card's Cities table, a city name opens that city's log for
      today, across workers and items.
- [x] The log works for workers on older monitors too, from what the
      coordinator already sees:
      - the handout;
      - the search pages;
      - the alerts;
      - the lease closing, being given back or expiring.

      Only the `[City]` start, finish and stop events and the phrase need the
      new monitor.
- [x] Against an older console, the ERP shows no City log and works as today.
- [x] Ships as facebook-tracker 0.13.17, with a new vendored monitor pin, and
      as ERP 1.331.0. `docs/FEATURES.md` describes the log.

## Out of scope

- A Telegram message per city. One per city would be noise in the alert
  topics.
- Editing or deleting log entries.
- A fleet-wide log page in the ERP. The worker page and the round card's
  cities are the two ways in.
- Keeping more than 14 days. The log is pruned with the rest of the queue's
  history (`SEARCH_CYCLE_DAYS`).

## Notes

- **Design:** *Phase 5: the city log* in
  [2026-10-23-fleet-city-queue-design.md](../superpowers/specs/2026-10-23-fleet-city-queue-design.md).
- **Visits are read, not stored.** One append-only `city_events` table holds
  the steps, and `rs_coordinator/city_log.py` groups them at read time. A
  worker searches one city at a time, so its step on another city ends the
  visit before. A visit's end comes from the first of these that applies:
  1. the monitor's own word;
  2. its lease: closed by the next ask, or run out (`expired`, which is
     derived on read, not a row);
  3. the worker moving on.

  That is why 0.13.12–0.13.16 workers show the day the coordinator ships.
- **Two contract additions are cut to the coordinator's limits on the
  monitor's side.** The page report's `search_phrase` is cut to 200
  characters, and the alert report's `title` and `price` to 300 and 60. A
  report over a limit would be refused whole, losing its funnel row or its
  alert row. Title and price are kept out of the `alert_messages` insert,
  which builds its columns from the record's keys.
- **The `[City]` lines** read, for example,
  `[City] Done Miami, FL for server_ram in 6 minutes: 3 searches, 84 cards, 9 opened, 5 reviewed, 1 alert.`
  A city cut off reads `Stopped … after 1 of 3 searches: wall (checkpoint)`.
- **Verified locally end to end.**
  - The stack: a coordinator on SQLite (:8511), a console on the real
    configs (:8611), and the ERP (8931/5180).
  - Through the real routes: nyc-1 was handed New York, started, three pages
    with phrases, an alert with its title, finished, then asked again. va-2
    was handed Washington, ran one empty page, parked on CHECKPOINT (logged
    as released) and stopped on a wall.
  - Back-dated rows covered the rest of the cases: finished, expired, given
    back on a restart, searching now, and an older own-list worker with
    pages only.
  - `rsc queue log --events` printed every case. Playwright screenshots
    covered the worker page's City log at 1440 and 1180 px, open rows, and
    the round card's city modal.
- **Tests.**
  - The coordinator suite: 614 tests, with Postgres parity on a throwaway
    container.
  - The console: 125. The vendored monitor: 509.
  - The ERP: backend 2545, frontend 1053, typecheck clean.
