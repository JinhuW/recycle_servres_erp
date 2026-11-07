---
id: RS-562
title: Fleet: count only real searches, pace budgets, SSD every second day
type: story
status: done
priority: P1
created: 2026-11-07
reporter: jinhu
branch: JinhuW/dugong
pr: "#1138"
version: 1.435.0
related: []
---

## Ask

> review the current facebook fleet data. ultrathink if we need to update the time we search for certain cities.
> for example, we receive 10 potential lead a day, then we can search once a day to twice day.

Then, answering the review's three questions (hold account 16; build the code
fixes; search SSD every second day):

> 1. yes.
> 2. yes,
> 3. yes.

## Context

A read-only review of Oct 31 to Nov 7 found about 10 new leads a day across the
whole fleet, with the busiest city at 1.9, so a leads-per-day rule would not fire.
Three other things were holding back lead finding:

- 37% of searches returned 0 cards, 94% of those from account 16. `reconcile` set
  the next due time from any finished search, so a 7-second blank cost a city its
  turn. Cities set to 1× got a real search about 0.5 times a day.
- 75% of search hours ran 00:00–10:00 ET, because `claim.ts` checks only the daily
  total and accounts spend it as soon as the Eastern day opens.
- SSD took 42% of search hours for 14% of new leads (10 of 72).

Modelled on the week's leads, fixing blanks and spreading searches cuts the median
time to find a lead from 4.2 h to 1.2 h. Fitted city-by-city moves did not beat
today's tiers on held-out data. Review:
http://10.10.100.225:8800/fleet-search-frequency-review.html

## Acceptance criteria

- [x] An account where at least half of its searches of one item (minimum 10) return 0 cards, in cities where other accounts find cards, is quarantined automatically.
- [x] A 0-card search does not use up a city's turn when another account found cards there in the last 7 days. The next account retries it once; a second 0 in a row is accepted as real.
- [x] `pace_percent` (0–100, default 0) paces the chosen accounts' budget across the Eastern day. 0 leaves behaviour exactly as today.
- [x] An item can run every N days (`every_days`, default 1): the gap is `1 day / per_day × every_days`, and a change reaches tasks already waiting.
- [x] Both new settings can be edited in the fleet Rules dialog.
- [ ] Prod runs `enterprise_ssd` at `every_days = 2` and `pace_percent = 15` after release.

## Out of scope

- Changing any city's `per_day`: recheck after two weeks of real searches.
- Finding why account 16 returns nothing.
- Per-item leasing, so a quarantine still covers the whole account.
- Removing cities.

## Notes

- Account 16 was held by hand on 2026-11-07 UTC until Nov 21, 04:46 UTC
  (`fleet_slots.quarantined_until`, evidence rule `manual_hold`). Release Quarantine
  on the worker page lifts it. Its probes use SSD, which it has never returned
  cards for, so a probe should not lift it.
- Nothing here restarts a worker, so nothing causes a Facebook login.
- Raising `pace_percent` past 15 waits for the owner: the effect on checkpoints is
  untested.
