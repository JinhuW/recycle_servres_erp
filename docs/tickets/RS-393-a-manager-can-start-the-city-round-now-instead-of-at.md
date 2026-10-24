---
id: RS-393
title: A manager can start the city round now instead of at the workers' start time
type: story
status: in-progress
priority: P2
created: 2026-10-24
reporter: jinhu
branch: fb-round-start
pr:
version:
related: [RS-385, RS-379, RS-372]
---

## Ask

> Add a buttom to start the task right now instead of waiting for the design start time

## Context

The city queue (RS-372, facebook-tracker 0.13.14) runs only at each worker's
`start_at`: 13:00 UTC, or 17:00 for the `b` partners. It hands out cities only
inside an 8 h window after that time, and only once they are due, 12 h after
their last search with `early=0.5`.

To run the pilot round at 21:49 UTC on 2026-10-23, the rules had to be changed
by hand (`rsc queue set early=0.9 window_hours=12`). The four pilot containers
were restarted, and the rules set back once the round was done. A restart is
a login. The first rule in AGENTS.md (RS-392) now forbids restarting a worker
to make a sweep start sooner.

## Acceptance criteria

- [x] The round card has a **Start the round now** button. Its confirmation
      says:
      - how many workers start now;
      - how many enrolled workers run an older monitor and so start only at
        their usual time;
      - how many cities are due for each item: those not searched in the
        last 2 h;
      - that the round runs for the window, and that the usual start times
        still run.
- [x] Confirming wakes the workers that are enrolled, HEALTHY, live, not
      quarantined, and on 0.13.18 or later. Each begins its sweep within about
      10 s with no container restart, through a `sweep` directive on the
      existing directive poll.
- [x] While the started round runs:
      - the window is open for every enrolled worker;
      - a city is due when it was not searched in the last
        `start_fresh_hours` (default 2);
      - the budget, leases and quarantine apply as usual.
- [x] The card's lede says who started the round and until when. The board's
      due states follow the started round's rule.
- [x] `rsc queue start [--dry-run]` does the same from the VM.
- [x] Against an older console, the button is absent.
- [x] Ships as facebook-tracker 0.13.18 and ERP 1.334.0. `docs/FEATURES.md`
      describes the button.

## Out of scope

- A per-worker "search now" button.
- Stopping a started round early. Unenrolling, or waiting out the window,
  does that.
- Changing the scheduled start times from the ERP.
- Restarting workers to deliver the new monitor. The owner decides when the
  15 healthy workers are recreated (AGENTS.md, first rule). Until then the
  preview shows them as "older" and the button wakes no one.

## Notes

- **Design:** *Phase 6: start the round now* in
  [2026-10-23-fleet-city-queue-design.md](../superpowers/specs/2026-10-23-fleet-city-queue-design.md).
- **The start is settings, not state.** `queue_config` `start` holds
  `{at, by}`, and `city_queue.with_start` turns it into a `started` key for a
  window's length. A start enrolls no one, needs no cleanup, and leaves the
  scheduled starts as they are. A city the started round searched is not due
  again at 13:00.
- **Why 2 hours, not the daily rule.** The pilot round needed `early=0.9`
  (2.4 h) to search cities the old workers had covered that afternoon. A
  start means "search now", so recency is the only bar, and
  `start_fresh_hours` makes it a setting.
- **The button waits for a redeploy.** Only a 0.13.18 monitor acts on
  `sweep`. AGENTS.md's first rule (RS-392) counts a worker recreate as a
  login, so the coordinator and console ship with every worker held, and the
  owner decides when the 15 healthy workers move. Until then the preview
  lists them as older, and the confirm button is disabled with the reason.
- **Verified locally end to end.** The stack: a coordinator on SQLite, a
  console on the real configs, and the ERP. Seeded with everyone enrolled,
  three HEALTHY workers on 0.13.18, va-2 on 0.13.17, ne-1 parked, and two
  cities searched just now.
  - The modal said 3 workers start and named va-2 as older. It counted
    125 of 127 server_ram cities due: the two just searched wait.
  - Confirming put "Started by Alex Chen at …, runs until …" in the lede.
  - Each 0.13.18 HEALTHY worker polled got `["sweep"]` once; va-2 and ne-1
    got nothing.
  - `next-city`, asked outside the worker's window, handed a city.
- **Tests.**
  - The coordinator suite: 624, with Postgres parity on a throwaway container.
  - The console: 127. The vendored monitor: 512.
  - The ERP: backend 2565, frontend 1068, typecheck clean.
