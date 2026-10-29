---
id: RS-452
title: Release-review fixes for the v1.379 prod cut
type: bug
status: done
priority: P1
created: 2026-10-29
reporter: jinhu
branch: JinhuW/review-fixes-1.379
pr: 989
version: 1.379.1
related: [RS-450, RS-451]
---

## Ask

> /code-review xhigh from dev to main, fix all issued and release to prod.

## Context

`dev` held eight commits `main` did not (v1.377.3 to v1.379.0, plus
facebook-tracker 0.14.18). The review found fifteen issues, all in RS-450
(Analysis counts every stage) and RS-451 (Retire & free a parked worker's
account). The ones that mattered most: Retire & free was offered on a
worker that had only gone silent, so a healthy account could be retired by
one click; the funnel still read rates over 100% on a day old and new
workers both ran; and the vendored monitor pin `ac161ad` was not on the
private mirror.

## Acceptance criteria

- [x] Retire & free shows only for a slot a manager parked, an account the
  pool already took out of the fleet, or a worker reporting a parked state,
  and not for a worker parked for an operator (DEAD connect_failed). One rule
  (`fleetSlotRetirable`, shared) decides it on both pages and in the API.
- [x] `POST /api/fleet/slots/:no/retire` refuses any other slot with 409
  `not_lost`.
- [x] Retiring puts the slot's leased tasks back on the queue even when the
  account had already left `fleet`, and cancels its probe.
- [x] Retiring from the Account Pool page drops the account's fleet slot too:
  both paths share `retireAccount`, and an account already retired gets no
  second event.
- [x] A release whose current worker comes back on another account passes
  the gate instead of failing on a lower epoch.
- [x] The dialog says that with no free account left the host runs one worker
  fewer.
- [x] A funnel day reports title, keywords, fresh, passed and withheld only
  when every search that counted cards carried them; a count past seven
  digits is left out instead of failing the endpoint.
- [x] The passed-to-alert rate leaves out withheld listings; a rate over 100%
  shows no number and says why.
- [x] A stage summed over fewer days than its neighbours is starred and
  footnoted, and the withheld sentence only shows when every day counted it.
- [x] Park, Unpark and Retire share one confirm dialog; the model and passed
  stages share their gate chips.
- [x] `ac161ad` is on `JinhuW/aimm-recycle-patches` `recycle-patches`.

## Out of scope

- The worker still counts `passed` only on a fresh verdict while `alerted`
  counts an alert sent on a cached one. Changing that is a worker release,
  and every worker restart is a Facebook login; the page now refuses to show
  such a step as a rate instead.

## Notes

- Pushed `ac161ad` (a fast-forward from `1550b6e`) to the mirror from the
  main checkout's clone.
