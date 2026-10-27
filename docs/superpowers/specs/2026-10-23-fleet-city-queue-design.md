# Fleet city queue — design

**Tickets:** RS-370 (shadow), RS-372 (first stage live) · **Date:** 2026-10-23 ·
**Status:** shadow built in facebook-tracker 0.13.13; first stage live in
0.13.14, piloted on homelab-1, nyc-1, phl-1 and va-2

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
the one decision, used by both the shadow report and the live queue. Since
the first stage, the region and partner rules below are off by default
(`regions=any`, `partners=false`), the budget is 360 minutes, and every city
is due once a day. Phase 3 explains why. It refuses, in this order:

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

## Phase 3: workers pull — the first stage (RS-372, 0.13.14)

**The owner's decisions** (2026-10-23), in answer to the three questions
below:

- **Regions:** none. Facebook does not care where the account's IP is
  against the searched city; sc-1 had searched Texas from a New York exit for
  weeks.
- **IP partners:** both rules go. Partners may share cities and search at
  once.
- **Frequency:** every city once a day per item. "Once all target cities get
  searched, then we can call it done": an empty queue ends the sweep.
- **Budget:** at most 6 hours of searching per account per day.
- **Rollout:** a pilot, then everyone.

**Changed from the outline above.**

- *There is no `city-done` call.* The next ask carries `done`, which closes the
  lease.
- *A visit is no longer judged by the city's median cards.* It is any search
  report for the item (or with no item), a pre-log `search_cities` stamp, or a
  closed or live lease. Quarantine stays the 0-card rule, and a quarantined
  account's searches count as nobody's visit.
- *There is no SKIP LOCKED.* The coordinator is a single process, so a
  process lock around pick-and-lease is enough on both backends.
- *There is no per-region pilot.* With no regions, the pilot is a set of
  accounts, and a city a live worker outside the queue holds stays its own
  (`held`), so the pilot never repeats a static sweep.

**Settings.** `queue_config['settings']` stores only the keys someone set:

| Setting | Default |
| --- | --- |
| `enrolled` | `[]` (`["*"]` is everyone) |
| `regions` | `any` (`home` restores the region rule) |
| `partners` | `false` |
| `per_day` | `1` (`null` follows the tiers) |
| `budget_minutes` | 360 |
| `window_hours` | 8 |
| `lease_minutes` | 30 |
| `quarantine_hours` | 48 |
| `early` | 0.15 |
| `familiar_days` | 7 |

**Protocol.** The worker posts `POST /v1/workers/{id}/next-city` with
`{item, home, start_at, done}`. It is always answered with a 200, because the
monitor reads anything else as "unreachable" and falls back to its own list.
The three answers:

- `{queue: false}`: the worker is not enrolled and searches its own list.
- `{queue: true, city: {slug, name, radius}, why}`: search that city.
- `{queue: true, city: null, reason}`: the sweep ends. The reasons are
  `nothing_due`, `budget`, `outside_window` and `quarantined`, plus
  `partner_busy` with `retry_after` when the partner rule is on.

**Leases.** `city_leases` holds one row per hand-out.

- **Renewed:** a HEALTHY heartbeat moves `expires_at` on by `lease_minutes`.
- **Given back:** any other reported state pulls it to now.
- **Closed:** the next ask's `done` closes it, and gives up the worker's other
  live leases for that item, which a crash left behind.
- **Minutes:** a worker's budget is counted from its leases, `(closed_at, or
  min(now, expires_at)) − leased_at`.

**Roster.** rs_console pushes `PUT /v1/queue/roster`. It sends the catalog
with each city's radius, and each worker's home cities, `proxy_env`,
`start_at` and phrases. It pushes at startup, every 10 minutes, and as soon as
*Edit cities* saves. The asking worker's own `home` and `start_at` override
the roster's copy.

**Monitor** (`recycle-patches` `93e2566`):

- `search()` iterates `queued_cities()`.
  - `{queue: false}`, or no first answer, means `planned_cities` as before.
  - A queue lost mid-sweep leaves the own list's unsearched cities.
  - An empty answer ends the sweep.
- Every funnel report names its `item`, which `city_searches.item` records.

**Operate.**

- `rsc queue status` shows today's round: per item, cities searched, leased,
  due and held, and per worker, its minutes and leases.
- `rsc queue enroll <ids>|--all`, `unenroll`, `set key=value` and `show`
  change and print the settings.

**Rollout.**

1. Deploy 0.13.14 with every worker held.
2. `rsc queue enroll homelab-1 nyc-1 phl-1 va-2`: one 28-city list plus three
   idle helpers.
3. Recreate only those four.
4. After a pilot day, `rsc queue enroll --all` and recreate the rest.

## Phase 4: the ERP page

The worker page's *Edit cities* becomes *Home cities*. The fleet page shows
each city's next due time, lease holder and home workers.

## Phase 5: the city log (RS-385, 0.13.17, ERP 1.331.0)

The owner asked for "an log for each each cities": once a worker finishes a
city, a brief report of its results. Then: "a full lifecycle logs not just
finish".

**One append-only table, two writers.** `city_events` holds one row per step.

- **The coordinator** writes what it already sees:
  - `handed` at `next-city`, stamped as the lease's `leased_at`, which is how
    a visit finds its lease;
  - `searched` from each funnel report that names its city, now with the
    phrase;
  - `alerted` from each delivered alert, now with the listing's title and
    price;
  - `released` when a parking heartbeat, or an ask after a restart, gives a
    lease up.
- **The monitor** (vendored `e045334`) reports what only it sees:
  - `started`: the searches planned, and queue or own list;
  - `finished`: its own count of the city and the seconds it took;
  - `stopped`: the reason (a wall and its kind, a lost session, a pause, a
    sweep cut short, or an error) and how far it got.

  It logs the same as `[City]` lines.

**Visits are read, not stored.** `city_log.visits` groups a worker's steps
into one visit per city. A worker searches one city at a time, so its step on
another city ends the visit before. The outcome is read from the first source
that has one:

1. the monitor's own `finished`, `stopped` or `released`;
2. the lease: closed by the next ask, or run out unclosed, which reads as
   `expired`;
3. the worker moving on, or half an hour of silence, for a visit with no
   handout or start: an older own-list monitor;
4. `searching` while steps keep coming, else `quiet`.

The log therefore works for 0.13.14–0.13.16 queue workers and 0.13.12 own-list
workers on the day the coordinator ships, before any worker is recreated.

**Read by** `rsc queue log`, the console's `GET /v1/city-log` (by worker or
city, up to 72 h), the ERP worker page's *City log* card, and the round card's
city names.

## Phase 6: start the round now (RS-393, 0.13.18, ERP 1.334.0)

The owner asked for "a buttom to start the task right now instead of waiting
for the design start time". Running the pilot round outside 13:00 had taken
three steps: hand-set rules (`early=0.9 window_hours=12`), container restarts,
and setting the rules back. Restarts are logins, which AGENTS.md's first rule
now forbids for this.

**A stored start, applied as settings.** `queue_config` `start` holds
`{at, by}`, and `city_queue.with_start` turns it into a `started` key for a
window's length. While it is there:

- `next_city` skips the window check;
- `pick` and `queue_status` treat a city as due once it was not searched in
  the last `start_fresh_hours` (2 by default), instead of the per-day ratio
  with `early`;
- nothing else changes: the budget, leases, held cities and quarantine all
  apply.

Nothing is enrolled or unenrolled by a start, and it needs no cleanup.

**Waking without a restart.** A new `sweep` directive rides the existing
directive poll (every 10 s) and heartbeat, like `relogin` and `restore`. The
monitor sets a flag. The idle loop's `doze` wake sees it, and the loop runs
every job at once: the start-up path, now `_run_all_jobs`. Each job keeps its
next scheduled run. Only workers on 0.13.18 or later act on it, so the
preview names the others, which start at their usual time.

**Preview first.** `GET /v1/queue/start` says what a start would do, so the
ERP's confirmation can show who starts, who waits, and how much is due before
anything is changed.

## Decisions to confirm (from the shadow report) — answered in phase 3

1. **Which exits may search which regions**, especially the three regions with
   no local exit.
2. **The budget**: minutes per account per day, and a ramp for new accounts.
3. **How often**: the tier split (top 20% 3×, next 20% 2×, the rest 1× by
   default), and active windows long enough for a 3× city.
