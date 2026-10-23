---
id: RS-372
title: Workers pull their cities from the coordinator's queue (first stage)
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: fb-city-queue-live
pr: 850
version: facebook-tracker 0.13.14
related: [RS-370, RS-277, RS-334]
---

## Ask

> Seem facebook does not care of the account region with the search region.
>
> Once all target cities get search, then we can call it down.
> In the firse stage, let we search once per cities.
>
> 2. Max 6 hours.

Answers to the follow-up questions:

> How should the live queue roll out to the fleet? — Pilot, then all
> Do the IP-partner rules stay? — Drop both
> What does 'Max 6 hours' limit? — Searching per day

## Context

RS-370 (facebook-tracker 0.13.13) put the city queue's decision rule,
`city_queue.pick`, into the coordinator and replays it as a shadow report. No
worker followed it.

These are the owner's answers to the three decisions that report was built
to settle:

- **Region.** None: Facebook does not care whether the account's IP and the
  searched city match.
- **IP partners.** Both rules go: partners may share cities and search at the
  same time.
- **Frequency.** Every city once a day, and the round is done when all have
  been searched.
- **Budget.** At most 6 hours of searching per account per day.

So workers now pull. An enrolled worker asks the coordinator for its next city
inside each item's sweep. It stops when there is nothing left, its budget is
spent, its window is closed, or it is quarantined.

The pilot comes first, and it must never double a static sweep: a city that a
live worker which is not enrolled still holds stays with that worker.

## Acceptance criteria

- [x] An enrolled worker gets each next city from
      `POST /v1/workers/{id}/next-city` and searches it, including a city
      outside its own config, with the catalog's radius. It searches nothing
      when the answer is no city: the round is done, the budget is spent, it
      is outside its window, or it is quarantined. It falls back to its own
      list only when there is no answer at all.
- [x] Each (item, city) is handed out once per day across enrolled workers. A
      city held by a live, unquarantined, not-enrolled worker stays that
      worker's.
- [x] An account stops at 6 h of searching per UTC day and is never handed a
      city outside `start_at` + 8 h. So a restart outside the window, or after
      the round is done, searches nothing.
- [x] A worker that parks releases its lease at once. One that goes silent
      releases it after 30 minutes. Either way the city goes back to the
      queue.
- [x] An account whose every search over 48 h returns 0 cards, on cities
      other accounts get cards from, gets no city, and its searches do not
      count as visits.
- [x] Funnel reports carry the item, so a visit is per (item, city).
- [x] `rsc queue status | enroll | unenroll | set` manage the queue.
- [x] The console pushes the roster every 10 minutes, at startup and after
      *Edit cities*.
- [x] homelab-1, nyc-1, phl-1 and va-2 are enrolled and recreated on the new
      image. The other 36 workers are untouched.
- [x] Ships as `facebook-tracker` 0.13.14.

## Out of scope

- **Enrolling the rest of the fleet.** That happens after the pilot day has
  been looked at, with `rsc queue enroll --all` plus a deploy that recreates
  the workers.
- **Acting on quarantined accounts** with an ops note or parking.
- **Searching busy cities more than once a day.** The tiers stay off in this
  stage.
- **An ERP page for the queue.**

## Notes

- Design: [2026-10-23-fleet-city-queue-design.md](../superpowers/specs/2026-10-23-fleet-city-queue-design.md),
  *First stage (live)*.
- **Vendored monitor.** `recycle-patches` `93e2566` (parent `8979534`). The
  main checkout's clone was fast-forwarded to it the moment it was pinned, so
  this commit cannot be lost the way `96d9204` was.
- **End to end before merge.** A local coordinator was given the real roster:
  127 cities, 42 workers, with the pilot enrolled and five static holders
  live. The real `queued_cities()` then pulled for the four pilots,
  interleaved:
  - **Split.** They shared exactly homelab-1's 28 Southeast cities plus NYC
    and Philadelphia, 8/8/7/7 per item.
  - **No repeats.** No city was handed out twice, and no held city went out.
  - **Edges.** Outside the window a worker got nothing, and a worker that
    isn't enrolled got its own list.
- **Deployed 2026-10-23, in two steps.**
  - **19:39 UTC.** `scripts/deploy.sh` ran with all 40 workers held, and the
    coordinator and console came up on 0.13.14. The console's startup push
    still met the old coordinator, which answered 404, so the roster was
    pushed by hand at 19:40. The 10-minute loop kept it current after that.
  - **Before the pilots moved.** A read-only dry run of `next_city` in the
    container showed `nothing_due` for all four pilots and both items:
    today's 13:00 sweep is seeded from `search_cities`. For tomorrow at 13:05
    it gave homelab-1 Fort Myers, its most overdue home city.
  - **19:41.** `rsc queue enroll homelab-1 nyc-1 phl-1 va-2`.
  - **19:42.** `RS_DEPLOY_HOLD="<the other 36>" scripts/deploy.sh --redeploy`
    recreated only `rs-monitor`, `-nyc`, `-phl` and `-va2`.
  - **After the restart.** Each pilot's startup sweep logged "Nothing more for
    server_ram after 0 cities" (and the same for enterprise_ssd), so there
    was no off-schedule sweep. All four heartbeat HEALTHY on
    `0.13.14 (93e2566)`. The other 36 are still on 0.13.12, up 2 days.
- **Next.** The 2026-10-24 13:00 UTC sweep is the pilot day. Read it with
  `docker exec rs-coordinator rsc queue status` and
  `python -m rs_console.queue_shadow --days 1`. Then `rsc queue enroll --all`
  and a deploy that recreates the rest.
