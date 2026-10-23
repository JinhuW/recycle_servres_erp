---
id: RS-370
title: Shadow-run a pull-based city queue against the live Facebook fleet
type: task
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: fb-city-queue-shadow
pr: 847
version: facebook-tracker 0.13.13
related: [RS-277, RS-275, RS-334]
---

## Ask

> ultrathink the current city assigned model seem not efficient.
>
> I hope to build an task queue and list all cities and distribute all cities to workers. for example.
> Once a worker finish a city, then it can pull a new cities from the task queue.
>
> help me think of this is a good practice.

> Yes, Go ahead.

## Context

Each Facebook worker searches a fixed list of cities. A person sets the list on
the ERP's worker page (`PUT /v1/workers/{id}/cities`), and `city_tiers.py`
(RS-277) only narrows that list per `start_at` slot. The fleet has one slot
(13:00 UTC; the `b` partners have 17:00), so the tiers do nothing.

What that cost on 2026-10-23, read from the VM's `/v1/fleet` and
`/v1/stats/reviews/workers`:

- **Five accounts carry the fleet.** homelab-1, ne-1, mw-1, sc-1 and denver-1
  hold 18–28 cities each and browsed 2.8–4.9 h. They produced 92% of the
  day's cards (24,269 of 26,255). The other producing accounts hold one city
  each and idle after under 45 minutes.
- **No backup.** 123 of the 127 catalog cities are searched by exactly one
  live account. Meanwhile NYC, DC, Philadelphia and Las Vegas have two each.
- **Healthy but blind.** wc-1b, va-2b, nj-2b and nj-3b report HEALTHY, yet
  their searches of DC, Baltimore and NYC returned 0 cards. Other accounts get
  about 120 per search there, and the empty-search wall check did not flag
  them.

A pull queue is the right shape for workers that are uneven and unreliable.
Taken literally ("finish a city, pull the next") it would hurt this fleet in
four ways:

- It turns the deliberate idle after a sweep into more Facebook traffic.
- A blind account finishes a city in a minute and would drain the queue.
- It ignores exit geography and the rule that IP partners never share cities.
- It throws away each worker's local listing cache.

So the queue hands out only searches that are due, caps each account's daily
minutes, quarantines blind accounts, treats region and partner rules as hard,
and sends home cities before borrowed ones. This ticket is phase 1:

- the coordinator gets the decision function the real queue will run;
- it gets a log of every search;
- it replays the fleet's real availability through that function and reports
  the queue's outcome next to what the workers actually did.

No worker changes behaviour. The report is what the three open decisions get
settled on:

- which regions each exit may search,
- the per-account budget,
- how often each city is searched.

## Acceptance criteria

- [x] Every search report that names a city is logged with its cards,
      opened, reviewed and alerted counts (`city_searches`, pruned to 14
      days), on SQLite and Postgres.
- [x] `city_queue.pick()` returns the next city for one worker, or none and a
      reason. It applies, each on its own:
      - due ratio,
      - region eligibility,
      - IP-partner exclusion,
      - partner not busy,
      - daily budget,
      - quarantine,
      - home → familiar → other ordering.
- [x] An account with two or more searches in the window, all at 0 cards, on
      cities another account got cards from, is reported as quarantined, with
      the evidence.
- [x] The coordinator's `POST /v1/queue/shadow` (admin) replays 1–14 days
      through `pick`. It returns actual vs shadow figures per fleet, per
      worker and per city:
      - visits per day,
      - max gap,
      - browser minutes,
      - redundant visits,
      - cities with a gap over 26 h,
      - due time nobody was available for.

      What-if settings in the request change only the replay, never the
      stored tier settings.
- [x] The console's `POST /v1/queue/shadow` and
      `python -m rs_console.queue_shadow` build the roster from the
      `/v1/fleet` doc and return or print that report. The roster is the
      catalog with regions, plus each worker's home cities, `proxy_env`,
      `start_at` and phrases.
- [x] No worker, monitor, ERP route or ERP allowlist changes.
- [x] The design spec is in `docs/superpowers/specs/`, the README has a
      section on the shadow report, `docs/DATABASE.md` lists
      `city_searches`, and the change ships as `facebook-tracker` 0.13.13.

## Out of scope

These are follow-up tickets, in this order:

- **Acting on quarantined accounts**, with an ops note or by parking them.
- **The worker protocol**: `next-city` / `city-done`, leases, a roster stored
  in the coordinator, and the vendored monitor's city loop asking for its
  next city.
- **A pilot on one region**, then the whole fleet.
- **The ERP fleet page** showing each city's next due time, lease holder and
  home workers.

Also left out:

- Backfilling the search log from OpenSearch. The report fills in from the
  deploy onward.
- Changing anyone's cities or `start_at`. The report informs that; it does
  not do it.

## Notes

- Design: [2026-10-23-fleet-city-queue-design.md](../superpowers/specs/2026-10-23-fleet-city-queue-design.md).
- **Number.** This was RS-368 until two other sessions took that number
  (#846 merged, #845 open), so it skipped to RS-370 to leave 369 to #845.
- **Vendor re-pin.** The release gate could not run, because the pinned monitor
  commit `96d9204` existed only in a deleted worktree's clone.
  - It is rebuilt as `8979534`: the same parent `c20d341`, plus the one file
    the original changed, copied from the VM.
  - It matches the deployed tree byte for byte apart from the files the
    deploy filter keeps off the VM, and `VENDOR.md` records how this was
    checked.
  - `recycle-patches` still has no private remote, which is what lost the
    commit.
- **First replay.** This was a dry run on the real roster with a synthetic log
  shaped like the day's sweeps.
  - With the defaults, the busiest account drops from 302 to 188 min a day,
    redundant searches from 33 to 0, and the median account rises from 7 to
    114.
  - The cost: 31 cities go over 26 h, because sc-1 and mw-1 are the only
    live accounts eligible for South Central and the Midwest, and they run
    out of budget.
  - Letting nyc-1, phl-1, va-2 and west-1 search one more region each brings
    that to 0, with the busiest account at 194 min. That is the first of the
    three decisions.
