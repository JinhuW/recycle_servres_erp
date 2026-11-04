---
id: RS-523
title: Retire & free on the fleet Watch page
type: story
status: done
priority: P2
created: 2026-11-04
reporter: jinhu
branch: JinhuW/escolar-2
pr: 1082
version: 1.417.0
related: [RS-451, RS-452]
---

## Ask

> add a button here for retire and release.

## Context

"here" arrived without a screenshot. Asked which page, the owner chose the
Watch page, and for a healthy account chose "Lost accounts only".

Retire & free exists on the Accounts tab rows and the ERP worker page (RS-451,
guarded by RS-452), but the Watch page offers only Mark healthy and Re-login.
That page is where a manager sees the checkpoint or dead session, so retiring
meant leaving it first. `RetireSlotDialog` and `POST /api/fleet/slots/:no/retire`
already do the work.

## Acceptance criteria

- [x] The ERP Watch page shows Retire & free when the worker page would: its own
      slot or no worker's, and `fleetSlotRetirable` true
- [x] A healthy worker's Watch page does not show it, and neither does a slot
      held by another worker
- [x] The button opens the existing confirmation with the login warning, and
      nothing happens until it is confirmed
- [x] After confirming, the page re-reads the worker and the button is gone
- [x] Dev's read-only mirror does not show it

## Out of scope

- Retiring a healthy account in one click: declined, the backend's `not_lost`
  guard stays.
- The coordinator (homelab) Watch page: those workers have no fleet slot.
- A bulk Release parked on this page.

## Notes

The label stays Retire & free, the wording the other two pages use, so one
action keeps one name.

Checked in headless Chromium against a private local database with seeded
workers: a healthy worker has no button, and on a `CHECKPOINT` worker no call
goes out until the dialog is confirmed. After confirming, the account reads
`retired` and its slot is gone. The mirror case rests on the `!mirror` check and
was not driven. No real worker or account was touched.
