---
id: RS-564
title: Rerun the fleet search frequency review
type: task
status: backlog
priority: P2
created: 2026-11-07
reporter: jinhu
branch: JinhuW/dugong
pr:
version:
related: [RS-562]
---

## Ask

> Create an TODO in the current project and remind me to rerun the review

## Context

The 2026-11-06 review found no case for changing any city's `per_day` until
searches were real and spread out
(http://10.10.100.225:8800/fleet-search-frequency-review.html). RS-562 shipped those
fixes on 2026-11-07 in v1.435.0, so this reruns it on two weeks of real searches.

Account 16's manual hold ends on 2026-11-21 at 04:46 UTC, so decide its future
before then. After that it searches again until the mostly-blank rule catches it.

The review reads prod's `fleet_tasks`, the coordinator's `alert_messages` and
OpenSearch on `10.10.10.73:9200`, so it has to run from the office network. Method:
the agent memory `fleet-lead-rate-review`.

## Acceptance criteria

- [ ] Blank share, search hours by Eastern hour and time to find a lead are compared with the first review (37% blank, 75% of hours 00:00–10:00 ET, 12 h median scan gap).
- [ ] Accounts 1, 9, 11, 12 and 14 are checked for checkpoints and searches by hour, and the owner decides whether to raise `pace_percent` above 15.
- [ ] SSD at `every_days = 2` is checked for lost or slower SSD leads, and the owner decides whether to keep it.
- [ ] The owner decides whether account 16 stays held, is released or is retired.
- [ ] Each city is tested against the rule: at least 7 new leads a week for two weeks, at most 20 scheduled passes covering them, and a median time to find above 6 h. West Palm Beach, Melbourne, Modesto and Oakland are the first candidates.

## Out of scope

- Applying any change without the owner's yes.

## Notes

A cloud routine emails a reminder on Friday 2026-11-20 at 9 AM Eastern, the last
working day before the hold ends.
