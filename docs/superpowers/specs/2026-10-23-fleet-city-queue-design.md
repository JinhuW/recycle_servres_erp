# Fleet city queue — design

**Ticket:** RS-370 · **Date:** 2026-10-23 ·
**Status:** phase 1 (shadow) built, facebook-tracker 0.13.13

## The ask

> ultrathink the current city assigned model seem not efficient.
>
> I hope to build an task queue and list all cities and distribute all cities to workers. for example.
> Once a worker finish a city, then it can pull a new cities from the task queue.
>
> help me think of this is a good practice.

## The problem

Each Facebook worker searches a fixed list of cities. A person sets the list
on the ERP's worker page (`PUT /v1/workers/{id}/cities`), and the monitor walks
it once at each `start_at` time. `city_tiers.py` (RS-277) can thin a list per
slot, but with the fleet's single 13:00 UTC slot it thins nothing.

Read from the VM on 2026-10-23 (`/v1/fleet` and
`/v1/stats/reviews/workers`):

| | |
| --- | --- |
| Workers listed | 42, of which 15 report HEALTHY |
| Catalog | 127 cities in six regions (`master.toml`) |
| Load | homelab-1, ne-1, mw-1, sc-1 and denver-1 hold 18–28 cities each, browse 2.8–4.9 h a day and produce 92% of the cards (24,269 of 26,255). The other producing accounts hold one city and finish in under 45 minutes. |
| Backup | 123 of 127 cities have exactly one live account. NYC, DC, Philadelphia and Las Vegas have two each. |
| Blind accounts | wc-1b, va-2b, nj-2b and nj-3b are HEALTHY, yet their searches of DC, Baltimore and NYC return 0 cards where others get about 120. The empty-search wall check does not flag them. |
| Exits | 15 of 20 proxy exits are on the East Coast, 4 in Palo Alto, 1 in Seattle. None are in the Midwest, South Central or Mountain regions, which sc-1, mw-1 and denver-1 search from NYC, Ashburn and Seattle IPs. |
| One city | ≈ 9.5 browser-minutes for two phrases through the residential proxies, so a full pass of 127 is ≈ 20 browser-hours |

## The shape this takes

Pull is right for workers that are uneven (one city or twenty-eight) and
unreliable (checkpoints, expired sessions, blind accounts). A worker asks for a
city when it is ready and gets the most overdue one it may search, so the load
follows who is up and a parked account's cities go to someone else.

A literal "finish a city, pull the next" would hurt this fleet four ways, so
the queue is bounded:

1. **Due work only, under a budget.** The idle after a sweep is the fleet's
   rate limit (`master.toml`: "A long idle after a sweep is the rate-limit
   WORKING"). A queue that fills it is more Facebook traffic, not more
   coverage. Only due cities are handed out, each account has a daily budget
   of browser minutes, and an empty queue means idle.
2. **Blind accounts get nothing.** In a pull queue the fastest consumer gets
   the most work, and a blind account finishes a city in a minute instead of
   nine. An account whose searches all return 0 cards, on cities other
   accounts get cards from, is quarantined.
3. **Region and IP partner are hard rules.** A worker searches only the
   regions its home cities, or its IP partner's, are in. It never takes a city
   its partner holds or searched lately, and never starts while its partner
   is mid-search. These encode `deploy/README.md` → *Scaling notes*.
4. **Home first.** Each worker's listing cache is its own, so a city that
   moves re-opens listings and re-asks the LLM. A person's searches also stay
   near home. A worker takes its own due cities first, then ones it searched
   lately, then anyone's.

## Rules

`rs_coordinator/city_queue.py` `pick(worker, now, fleet, state, settings)` is
the one decision. The shadow report uses it now and the live queue will later.
It refuses, in this order:

| Refusal | When |
| --- | --- |
| `quarantined` | The account is quarantined. |
| `budget` | The account has used `budget_minutes` (default 180) this UTC day. |
| `partner_busy` | An IP partner (same `proxy_env`) is mid-search or finished less than `partner_gap_minutes` (30) ago. |
| `nothing_due` | No eligible city is due. |

Otherwise it returns a city:

- **Eligible.**
  - The city is in a region holding the worker's or its partner's home
    cities. A city outside every region is its own region.
  - It is not a partner's home city, and no partner searched it within
    `partner_days` (7).
  - The `eligibility` setting replaces the region rule per worker.
- **Due.**
  - `now − last visit ≥ (24 h / per_day) × (1 − early)`, with `early` 0.15.
    A city never searched is due.
  - `per_day` is `city_tiers.rank()` over the whole catalog, with the stored
    tier settings and pins.
  - A visit is stamped when the city is handed out, which keeps a second
    worker off it.
- **Order.** Home → familiar (this worker searched it within
  `familiar_days`, 7) → other. Within each group, the most overdue first,
  then by slug.

A visit takes `phrases × search minutes`. Search minutes is the worker's
median gap between consecutive search reports of 20 minutes or less, clamped
to 2–20. With fewer than three gaps it is `search_minutes` (4.75).

**Quarantine.** Two or more searches in the window, every one at 0 cards, on
cities another account got cards from. A city everyone gets nothing from is
empty and convicts nobody.

## Phase 1: shadow (this ticket)

Nothing a worker does changes. The coordinator learns to decide, and
reports what it would have decided.

- **Search log.**
  - `POST /v1/stats/reviews` now also writes `city_searches` (worker, city,
    at, cards, opened, reviewed, alerted) for every report that counts a
    search and names its city.
  - Pruned to 14 days.
  - The monitor already sends this; nothing on the worker side changed.
- **Replay.** `simulate` wakes each worker at its `start_at` times. It does so
  only when the worker's status history says it was up: HEALTHY, and not
  dead. The worker then asks `pick` until its `window_hours` (8) close,
  waiting `poll_minutes` (15) after each refusal.
  - It starts a day before the window from the log's real last visits, so
    the window does not measure a cold start.
  - Quarantined accounts are excluded, and their searches never count as
    coverage on either side.
- **Report.** The coordinator's `POST /v1/queue/shadow` (admin) takes
  `days` (1–14), what-if `settings` (any rule above, plus `tiers`) and the
  roster. It returns the same figures for the actual fleet and for the
  replay, for the fleet as a whole, per worker and per city:
  - searches a day;
  - browser minutes a day, in total, for the busiest account and for the
    median account;
  - accounts used;
  - redundant searches: another account searched the city within its
    interval;
  - cities with a gap over 26 h;
  - overdue city-hours.

  `partial` says the window starts before the log does. What-if settings
  are never saved.
- **Roster.** Only the console reads the worker configs, so it sends the
  roster. `rs_console/queue_shadow.py` `roster()` builds it from the
  `/v1/fleet` document:
  - the catalog with regions;
  - each worker's home cities;
  - `proxy_env` as the partner key;
  - `start_at`;
  - `plan.phrases`.

  The console's `POST /v1/queue/shadow` and the
  `python -m rs_console.queue_shadow` CLI send it on. The ERP does not
  forward the route.

### What the first replay already says

This was a dry run before deploy, against today's real roster and a synthetic
three-day log shaped like today's sweeps:

| | actual | shadow, defaults | shadow, wider eligibility |
| --- | ---: | ---: | ---: |
| Busiest account, min/day | 302 | 188 | 194 |
| Median account, min/day | 7 | 114 | 176 |
| Redundant searches | 33 | 0 | 0 |
| Cities with a gap over 26 h | 0 | 31 | 0 |

The wider eligibility let nyc-1 → Midwest, phl-1 and va-2 → South Central,
and west-1 → Mountain.

At the default 180-minute budget, sc-1 and mw-1 are the only live accounts
eligible for South Central and the Midwest, and they run out of budget, so
those regions slip past a day. Either the budget rises for them or more exits
may search those regions. That is decision 1 below, and it is exactly what
the report is for.

## Phase 2: act on blind accounts

The quarantine verdict, live: an ops note when an account turns blind, and the
console shows it on the worker's row. This is useful before any queue, since
today these accounts sit HEALTHY doing nothing.

## Phase 3: workers pull

- **Roster in the coordinator.** The console pushes it on every config render
  (deploy, *Edit cities*, settings saves). The coordinator stores it with
  `updated_at`, so `next-city` never calls back to the console.
- **`POST /v1/workers/{id}/next-city?item=`** returns `{slug, name, radius}`
  or 204 with the refusal. It runs `pick` under a per-(item, city) lease
  claimed with `UPDATE … WHERE … FOR UPDATE SKIP LOCKED`: Postgres in prod, a
  lock on SQLite. The lease expires after 30 minutes, and a heartbeat that
  reports a park releases it at once.
- **`POST /v1/workers/{id}/city-done`** carries cards, opened, reviewed and
  alerted.
  - 0 cards where the city's recent median is above 0 does not count as a
    visit, and the city goes back in the queue.
  - Two such results quarantine the worker.
- **Monitor.** In the vendored `facebook.py` `search()`, the
  `zip(planned_cities(...))` loop becomes "while `next-city` gives one". Item
  jobs and `start_at` stay, and `start_at` now means "when this account is
  active".
  - If the coordinator cannot be reached, the worker searches its own home
    cities, as it does today when `search-plan` fails, never the whole
    catalog.
  - A city from the coordinator may be outside the worker's config, so its
    radius comes with it.
- **Rollout.** Pilot one region's accounts first, then the rest.

## Phase 4: the ERP page

The worker page's *Edit cities* becomes *Home cities*. The fleet page shows
each city's next due time, lease holder and home workers.

## Decisions to confirm (from the shadow report)

1. **Which exits may search which regions**, especially the three regions with
   no local exit.
2. **The budget**: minutes per account per day, and a ramp for new accounts.
3. **How often**: the tier split (top 20% 3×, next 20% 2×, the rest 1× by
   default), and active windows long enough for a 3× city.
