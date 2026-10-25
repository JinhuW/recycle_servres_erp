# WS-E2 · Rework the fleet tabs into the approved design

**Depends on:** WS-E merged (v1.337.0, v1.341.0) and the WS-A/B routes on
`dev`. **Design:** [`WS-E-ui-mock.html`](WS-E-ui-mock.html), approved by the
owner on 2026-10-24. Open it in a browser from the repo; its data is invented
and its clock is fixed at 11:40 Eastern, but its layout, copy, states and
empty states are the target. Match them. **Owns:** everything WS-E owns
(`apps/frontend/src/lib/fleet.ts`, `pages/desktop/fleet/*`, their tests,
`fleet*` i18n keys, `styles/fleet.css`) plus `pages/desktop/DesktopCoordinator.tsx`,
the fleet-tab parts of `lib/route.ts`, and `pages/desktop/FleetFlow.tsx`,
which moves tab.

## Target

Monitors ▸ Facebook keeps its sidebar entry and its page title. The page has
five tabs, in this order:

| Tab | Route | Content |
| --- | --- | --- |
| Fleet | `/fleet` (opens first, as today) | a strip of host cards, then one table of every account with a Host column |
| Tasks | `/fleet/tasks` | the 24-hour belt, the task table with filters, the city log beside it |
| Cities | `/fleet/cities` | the catalog, as shipped, aligned to the mock |
| Analysis | `/fleet/analysis` | the search-to-alert pipeline, moved off the Fleet tab, with a range, two per-day charts and alerts by city |
| Account pool | `/fleet/pool` | as today, plus a Runs on column |

The Queue, Hosts and Slots tabs go away; their content moves as described
below. `/fleet/queue` redirects to `/fleet/tasks`; `/fleet/hosts` and
`/fleet/slots` redirect to `/fleet`. Purchasers still see Account pool only.
Desktop only, as before.

## Tasks

1. **Fleet tab.** Replace the Fleet tab's body with:
   - A **host strip**: one compact card per host from `fleetApi.hosts()`
     with the host id, agent version, last seen, running of capacity, the
     authoritative toggle, the capacity stepper and, when a roll is on, its
     progress line with Pause. *Add host* (token shown once) and *Release a
     version* move to the tab's action row. This is the shipped Hosts tab,
     compacted; keep its dialogs and its tests.
   - **One table of every account.** Columns: Account (no, masked uid),
     Host, Worker (id, VNC port), State (chip plus a one-line note), Now
     (current task city and item, elapsed, cards so far, "home city"; or
     "Waiting for a task"; or, for a worker being replaced, "Stopping after
     this task, then back on <version>"), Today (minutes ring against
     `budget_minutes`), Lease (epoch, renews in), Version, and the eye to the
     worker page. Rows come from `fleetApi.slots()` and `fleetApi.workers()`
     merged by account number. **Until cutover** the coordinator's workers
     are rows too (`coordinatorApi.fleet()`, as the current Fleet tab reads
     them) with Host shown as `homelab`; when both sources know an account,
     the ERP row wins. An account that nothing runs is a row with no host:
     its chip says why (Session expired, Checkpoint, Quarantined with
     "until … · next probe …", In manual use with the holder) and its Now
     cell holds the action (Release quarantine, Unpark, Park), so the Slots
     tab's actions all live here. Sort running rows first, by worker id,
     then idle rows by account number.
   - **Filters** in the table's toolbar: the status legend with counts (All,
     Healthy, Degraded, Replacing, Quarantined, Parked, In manual use), a
     host select (every host, each host, Not running) and a search box over
     worker, account, city and host. The card foot states "N of 41 accounts ·
     M running on K hosts".
   - Keep the activity aside under the table while the coordinator rows
     exist; WS-F drops it with them.
2. **Tasks tab.** Rename the Queue tab and replace the round board with the
   **belt**: a card with one row per enabled item, a 24-hour window centred on
   now in Eastern time, quarter-hour buckets. Left of now, done tasks (green
   squares); at now, the overdue stack as one bar labelled "N due now"; just
   right of now, leased tasks (blue, one mark per worker); right of now,
   ready tasks at their due time (outlined; amber outline inside the next
   hour). Hover titles name the city, time and worker. Each row's label gives
   the item and two count lines; a sentence above the belt gives workers
   busy, city-items due, minutes to clear the backlog at the measured
   average task length (`result.seconds` of today's done tasks, 6 minutes
   when there are none), done in the last 12 hours and due in the next 12.
   Put the bucketing and the sentence in `fleetBoard.ts` with vitest cases.
   Below the belt: the shipped task table with a state segment (All,
   Running, Due, Done, Cancelled, Expired), item select, search and range,
   and the city log as an **aside beside the table** (not a modal): the
   city's name, slug, home worker and region, then per item the open task
   and the last two finished ones with their events. *Search a city now* and
   *Start the round now* stay as shipped, in the tab's action row.
3. **Cities tab.** Align the shipped tab to the mock where it differs: the
   status legend (All, Enabled, Pinned, Verifying, Disabled) and a region
   select in the toolbar; verifying cities sorted first, each with an inline
   row that names the label Facebook returned, *Enable anyway* and *Remove*
   on a mismatch, *Skip the check* otherwise; per item a cell with last done
   (time, cards, alerts) and the open task as a chip (running with its
   worker, due and waiting, or "next <time>"); a Home of column; the *Rules*
   dialog for `fleetApi.settings()` in the action row next to *Add city*.
4. **Analysis tab.** Move `FlowCard` (`FleetFlow.tsx`) here from the Fleet
   tab, then add:
   - A **range** segment, Today / 7 days / 14 days, that sums the per-day
     rows of `coordinatorApi.reviewStats(14)` for every stage counter; the
     card sub says "today, all workers, both items" or the range.
   - The **pass rate between stages** under each arrow (cards per search as
     "×N"), marked when under 50%, and a sentence under the pipeline with
     the headline ratios (cards per alert, reviews per alert, the title
     gate's and the model's drop).
   - Two **per-day bar charts** for the last 14 days, each on its own axis:
     reviewed by the model, and alerts sent. Single hue (the accent), thin
     bars with rounded tops, three gridlines, labels on the first, highest
     and today's bar, today's bar grey as partial, a hover title per bar, a
     14-day total and a full-day average under each.
   - **Alerts by city**, last 14 days, from `coordinatorApi.alertHits(14)`:
     city, region, alerts, reviewed, alert rate, last alert, searched by
     (home worker or "whoever is free").
   - No worker or item filter: the coordinator's stats are not tagged per
     worker. Say so in `docs/FEATURES.md`.
5. **Account pool tab.** Add a *Runs on* column: the ERP worker (from
   `fleetApi.slots()`) with its state and epoch, linking to the worker page;
   else the coordinator holder as today; else the pool reason.
6. **Routes and chrome.** `FLEET_TABS` becomes `tasks | cities | analysis`;
   the tab bar in `DesktopCoordinator.tsx` renders Fleet, Tasks, Cities,
   Analysis, Account pool with the house icons and count chips (running
   workers on Fleet, due tasks on Tasks in the warn colour, cities, pool
   size). Keep the page title "Facebook fleet" on every tab.
7. **Tests, docs, version.** vitest for the belt helpers, the funnel range
   sums and the row merge; smoke tests per tab with mocked fetchers as in
   `FleetTabs.smoke.test.tsx`; `pnpm --filter recycle-erp-frontend test`,
   `pnpm typecheck`. Rewrite the Fleet (ERP-owned) bullets in
   `docs/FEATURES.md` for the five tabs, citing the version. Root minor bump
   and `CHANGELOG.md` section. Tick the exit criteria below and update the
   Status table in `README.md` in the same PR.

## Exit

- [x] Five tabs; the old three paths redirect; purchasers unchanged.
- [x] Fleet: host strip plus one table of all accounts with Host, idle rows
      with their reason and action, legend, host select and search working.
- [x] Tasks: the belt renders from `fleetApi.tasks()` with the counts
      sentence; the city log opens beside the table.
- [x] Analysis: the pipeline with pass rates and range, two charts, alerts by
      city; the Fleet tab no longer shows the pipeline.
- [x] Account pool shows Runs on.
- [x] Checked locally against a private database with a made-up account and
      `fleet-fake-worker.mjs`, as WS-E did; screenshots of each tab in the PR.

## Notes for the agent

- Times in US Eastern (`utcToEastern`, `lib/fleetView.ts`). Reuse the house
  chips, legend, rings and tables; add to `styles/fleet.css`, not new files.
- The mock's numbers (41 accounts, 15 running, 127 cities) are the live
  fleet's shape on 2026-10-24, not fixtures to copy.
- Never cause a Facebook login (root `AGENTS.md`, first rule): nothing in
  this workstream touches a host or a worker.

## Verification

- Frontend: 94 files, 1,150 tests passed; workspace typecheck and production
  frontend build passed.
- Private Postgres on 55499: fake worker claimed an invented account,
  completed two searches, reported `done_only`, and saved its session.
- Local browser: all five tabs, old redirects, account search, city-log aside,
  Analysis range and daily-value table, purchaser pool-only access and a
  1000 px viewport checked. Screenshots are in `WS-E2-screenshots/`.
- Backend suite: 2,640 passed, one existing budget-fixture failure. At
  02:55 UTC its `NOW() - interval '7 hours'` lease starts yesterday, while
  `fleet_minutes` assigns minutes to the lease's UTC date. The fixture
  therefore does not spend today's budget. The backend implementation and
  test are identical to `dev`; this frontend rework leaves them unchanged.
- Analysis daily totals retain the coordinator's UTC day boundaries. City
  alert rates stay blank when the ERP task history cannot account for the
  coordinator alert total or hits the 1,000-row cap. No new API contract.
- No Facebook login, worker restart, deployment or live-host change.
