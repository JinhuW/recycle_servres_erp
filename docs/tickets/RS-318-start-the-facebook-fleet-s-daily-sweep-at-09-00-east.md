---
id: RS-318
title: Start the Facebook fleet's daily sweep at 09:00 Eastern
type: task
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: fleet-workers-start-9am
pr: "#782"
version: facebook-tracker 0.13.5
related: []
---

## Ask

> all workers started two early.
> [Image #1]
>
> Let we start at 9:00 am east time.

(The image is the ERP's Monitors ▸ Facebook fleet page, showing every live
worker's sweep starting between 00:01 and 01:11 in its own zone instead of at
the scheduled 06:00 ET, and "tomorrow 06:00" as the next sweep.)

## Context

The fleet sweeps once a day at the workers' `start_at`, a UTC clock time in
`trackers/facebook/configs/master.toml` copied into every `homelab-*.toml`.
It has been `["10:00"]` (06:00 EDT) since 2026-09-06, and nothing is saved
over it from the ERP's search settings (`/state/settings.json` does not exist
on the VM), so the file is what the fleet runs.

The 01:10 ET starts in the screenshot were not the schedule. facebook-tracker
0.13.0 was released at 01:05 ET on 2026-10-19 (0.13.1 at 02:49 ET) and its
deploy recreated every worker; the monitor runs one sweep immediately on
startup, so each worker swept as soon as it came up. That wrinkle is already
documented in master.toml's schedule comment.

The owner wants the daily sweep at 09:00 Eastern. 09:00 EDT is 13:00 UTC.

## Acceptance criteria

- [x] `start_at = ["13:00"]` in `master.toml` and every `homelab-*.toml`,
      with the comment saying 09:00 Eastern and the DST note updated
      (13:00 → 14:00 when New York falls back).
- [x] The change is written under `[Unreleased]` in the tracker's CHANGELOG
      and the README's fleet-verify note matches the new sweep time.
- [x] Released as facebook-tracker 0.13.5 and deployed with
      `scripts/deploy.sh sync`; the ERP's fleet page then shows the next sweep
      as 09:00 ET for every worker.

## Out of scope

- Making `start_at` time-zone aware so it follows DST on its own. The monitor's
  scheduler takes a UTC clock time; the manual 13:00 → 14:00 step stays.
- Suppressing the sweep a worker runs on startup or on a config change. A
  deploy, including this one, still starts one sweep straight away.

## Notes

- The daily `fleet-verify.py` cron on the VM fires at 21:05 UTC, chosen as
  "after the 10:00 UTC sweep has had 6–9 h". With a 13:00 UTC start a long
  sweep now runs until ~22:00 UTC, so the crontab entry moves to 23:05 UTC
  (19:05 ET) with the deploy.
- The ERP's search settings card can change the sweep time at any time; a
  value saved there overrides this default until `/state/settings.json` is
  deleted.
- Deployed 2026-10-19 15:45 UTC with `scripts/deploy.sh sync`. Every worker
  config on the VM carries `13:00`, the workers restarted and the console's
  `/v1/fleet` reports `search.start_at = ["13:00"]`; the cron was moved. The
  deploy's verify step still reported code DRIFT: `sync` rebuilds no image,
  and the VM's worker image is the 0.13.1 build because 0.13.2–0.13.4 (the
  pre-screen releases) were never deployed. The next full `scripts/deploy.sh`
  clears it by shipping that code.
