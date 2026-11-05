---
id: RS-546
title: Fleet: show outages, holds and exit alerts on desktop
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/cloak-fixes-wave-4
pr:
version: 1.425.0
related: []
---

## Ask

> the dev change about the new cloakbrowser integration and some other minior change.
>
> Identify all issue and make sure these will not break any existing service.

> pls create an comprensive fix plan for these issue.

> 1. Yes. Probe hourly/
> 2. allow it.
> 3. Manager click start

## Context

Wave 4 of the CloakBrowser fix plan: review finding 13 and five screen items. A
licence outage, a held worker and the exit-change alert showed nowhere on a desktop,
since only the phone shell reads notifications.

## Acceptance criteria

- [x] The Fleet tab shows a banner for outages, held containers and unread fleet alerts.
- [x] A worker row names `Licence outage` or `Exit moved`, and an outage row offers no Retire.
- [x] A worker parked on `exit_moved` offers Restart, which warns it is one boot login. The ERP never queues it by itself.
- [x] An outage alerts managers at most once an hour.
- [x] Dismissing an alert marks only that notification read.
- [x] Add to fleet picks a pilot from a list, makes the arm an explicit choice, and doesn't name a clock it won't use.
- [x] A pilot or arm can be corrected before the first claim, and not after.
- [x] `pilot_arm` and `cloak_seed_taken` read as sentences, a failed cohort read shows a message, and a crossed account is marked.
- [x] Saving a new proxy URL runs a check at once.

## Out of scope

Exit-change alerts in a general desktop inbox: the banner is only on the Fleet tab.

## Notes

Owner decision: a manager's click restarts a worker whose port moved after a live
session. The route reuses the `resume` directive, which the worker answers by leaving
for a new browser, and the heartbeat's auto-resume still only covers `connect_failed`.

`/api/notifications/mark-read` with no body still marks everything read, which the
phone shell relies on. It now takes an optional `id`.
