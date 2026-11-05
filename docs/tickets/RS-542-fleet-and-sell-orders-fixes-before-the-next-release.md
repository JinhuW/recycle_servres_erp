---
id: RS-542
title: Fleet and sell orders: fixes before the next release
type: bug
status: done
priority: P1
created: 2026-11-05
reporter: jinhu
branch: JinhuW/cloak-fixes-wave-0
pr: 1099
version: 1.424.2
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

The `/code-review max` of the CloakBrowser work on `dev` kept 60 findings
(page: `cloakbrowser-dev-review-20261105.html`), and the fix plan splits them
into six waves (`cloakbrowser-fix-plan-20261105.html`). This ticket is wave 0:
the five that the next `main` release would expose, none of which touches a
worker or a host.

## Acceptance criteria

- [x] The desktop sell-order Total shows the USD total, not a dash, when the backend sends no `nativeTotal`.
- [x] The cohort search count uses the scheduler's rule, so `wall (checkpoint)` and other reason strings don't count as completed.
- [x] A worker older than 0.17.0 gets no cloak slot.
- [x] The cohort card polls every 5 minutes and reads once on mount.
- [x] `fb_worker_accounts` has an index on the account for the scorecard's lookup.

## Out of scope

Waves 1 to 5, each with its own ticket. The proxy round and Proxies tab query
costs wait for wave 5, because they need timing on Postgres 18.

## Notes

Owner decisions on the plan, 2026-11-05, for the later waves: probe hourly after
8 outage retries; allow Back to stock on a cloak-arm account and count it as
failed; a manager's click restarts a worker whose port moved after a live
session.

Raising the minimum version means any cloak slot on 0.16.0 waits for 0.17.0. The
launch plan measured no cloak slots on 2026-11-04; re-read that before releasing
to `main`.
