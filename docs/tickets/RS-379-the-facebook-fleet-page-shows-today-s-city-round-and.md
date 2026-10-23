---
id: RS-379
title: The Facebook fleet page shows today's city round and moves workers into the queue
type: story
status: in-progress
priority: P2
created: 2026-10-23
reporter: jinhu
branch: fb-queue-ui
pr:
version:
related: [RS-372, RS-370]
---

## Ask

> Pls update the UI to reflect this new task mode.

Answer to the follow-up question ("Should the ERP page only show the city
queue, or also let a manager run it?"):

> Show it + enroll workers (Recommended)

## Context

Since RS-372 (facebook-tracker 0.13.14), enrolled workers no longer walk
their own city lists: they ask the coordinator's queue for each city. The
pilot is homelab-1, nyc-1, phl-1 and va-2.

The ERP's Monitors ▸ Facebook pages still describe only the old model:

- each worker's fixed city list with tier marks;
- a "Searches" ring counted against that list.

So there is no way to see who takes cities from the queue, how far today's
round has got, what each pilot was handed, or whether an account is
quarantined. Enrolling the rest of the fleet is only `rsc queue enroll --all`
on the VM.

Enrolling has one trap, and the coordinator closes it here. A worker still on
an older monitor (0.13.12 runs on 36 of 40 today) never asks the queue. If it
were enrolled, its cities would stop counting as held and the pilots would
search them again. So the queue treats only workers on 0.13.14 or later as
able to pull, and refuses to enroll an older one by itself.

## Acceptance criteria

- [ ] A "Today's round" card opens the Fleet tab. For each item it has one mark
      per city:
      - searched today;
      - being searched now;
      - still due;
      - not due until later;
      - on a worker's own list.

      Under each item a sentence gives the counts, and a "Cities" list names
      each queue city's state and worker.
- [ ] The card says how many workers take their cities from the queue and
      states the stored rules: once a day, the per-account budget, the window.
- [ ] A manager can move every worker to the queue, or send every worker back
      to its own list, after a confirmation that says how many still run an
      older worker.
- [ ] In the workers table:
      - an enrolled worker carries a "Queue" chip;
      - its Searches cell shows minutes used against the budget;
      - its fold shows its home cities and the cities the queue handed it
        today.
- [ ] The worker page:
      - has a "City queue" row: in the queue or not, minutes used today,
        cities handed out, the city being searched now, quarantined;
      - labels the Cities row "Home cities" when the worker is enrolled;
      - lets a manager move the worker into the queue or back. The button is
        disabled, with the reason, for a worker older than 0.13.14.
- [ ] An enrolled worker on an older monitor never frees its cities to the
      queue, and enrolling one alone is refused with a 409 that says to
      redeploy it.
- [ ] Against an older console the page shows no round card and no queue
      controls, and works as today.
- [ ] Ships as facebook-tracker 0.13.16 and an ERP minor release.
      `docs/FEATURES.md` describes the card.

## Out of scope

- Editing the queue's rules (budget, window, searches a day) from the ERP.
  They stay on `rsc queue set`.
- A mobile view. The fleet pages are desktop-only.
- Redeploying the 36 older workers onto 0.13.16. That is a separate step, after
  the pilot day.

## Notes

- Design: [2026-10-23-fleet-city-queue-design.md](../superpowers/specs/2026-10-23-fleet-city-queue-design.md).
