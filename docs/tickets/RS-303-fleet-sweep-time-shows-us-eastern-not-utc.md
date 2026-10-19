---
id: RS-303
title: Fleet sweep time shows US Eastern, not UTC
type: story
status: done
priority: P2
created: 2026-10-18
reporter: jinhu
branch: fix-us-east-timezone
pr: 751
version: 1.287.1
related: []
---

## Ask

> update to use us east time here instead of UTC time.

(With a screenshot of the Fleet page's **From a search to an alert** card,
Search stage, showing the chip `Sweeps at (UTC) 10:00`.)

## Context

The workers' `start_at` is a UTC "HH:MM" because their containers run on
Etc/UTC (`trackers/facebook/configs/master.toml`: 10:00 UTC is 06:00 EDT). The
Search stage chip (`FleetFlow.tsx` `stageSettings`), the Edit form's draft
(`fleetView.ts` `settingsDraft`) and its PUT body (`settingsPatch`) all passed
that UTC value through unchanged under a "(UTC)" label, so reading or setting
the sweep meant doing the Eastern conversion in your head.

## Acceptance criteria

- [x] The Search stage chip reads `Sweeps at (ET)`, and a stored `10:00` shows as `06:00` while New York is on EDT.
- [x] The Edit form shows and accepts Eastern times; saving `06:00` sends `start_at: ["10:00"]` while on EDT.
- [x] Text that isn't HH:MM is sent as typed, so the console's 400 still names the field.
- [x] The edit hint says US Eastern, in English and Chinese.

## Out of scope

Making workers schedule in America/New_York. The stored value stays a fixed
UTC time, so the sweep still moves an hour against Eastern at DST: after
2026-11-01 the chip will truthfully show `05:00` until the config is changed
(master.toml's DST note). Fixing that is a tracker change.

## Notes

The conversion uses New York's UTC offset at the moment of viewing, which is
the Eastern time the sweep actually fires at that day. The tracker, console
facade and `/api/coordinator` proxy contract are unchanged.
