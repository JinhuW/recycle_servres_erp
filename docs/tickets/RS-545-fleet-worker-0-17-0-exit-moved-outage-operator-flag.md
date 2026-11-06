---
id: RS-545
title: Fleet worker 0.17.0: exit_moved, outage operator flag, honest resume
type: bug
status: done
priority: P1
created: 2026-11-05
reporter: jinhu
branch: JinhuW/cloak-fixes-wave-3
pr: 1102
version: facebook-tracker 0.17.0
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

Wave 3 of the CloakBrowser fix plan: review findings 1, 5, 7 and 9 plus four
preflight and record items, all in the vendored monitor at `recycle-patches`
`ee40173`. Worker 0.17.0 isn't on any host, so they join its first rollout and
cost no extra restarts. The ERP side (RS-543) is already on `dev`.

## Acceptance criteria

- [x] The outage heartbeat carries `operator: true`.
- [x] A preflight that fails only on the expected exit reads as `exit_moved`; a WebRTC failure beside it stays `profile_preflight`.
- [x] Before any page, `exit_moved` closes the browser and exits 75; after one it parks until a resume, which then exits 75.
- [x] A resume before any HEALTHY reports `DEGRADED`, on both engines.
- [x] Heartbeats carry `facebook_opened: true` once a page exists.
- [x] The zone check accepts the browser's own spelling of the pinned zone.
- [x] A dead browser parks `browser_failed`; a preflight heartbeats first and its script has a time limit.
- [x] A denial at the loop top hands back a finished task; only a real refusal reports `session_upload_failed`.
- [ ] Confirmed on the real CloakBrowser binary, by spikes S1 and S5.

## Out of scope

- The manager's Restart button and its route: wave 4.
- Cutting `facebook-tracker/v0.17.0` or staging an image: both wait for the owner's yes.

## Notes

Stays `in-progress` until 0.17.0 is released, because nothing here has run on a
host or on the real binary. `version:` gets filled at the release.

The script's time limit covers a hung promise, not a hung renderer.

Finding 7 reaches stock once a host runs 0.17.0: a stock first-login connect
failure stops reporting HEALTHY early. That is intended, and corrects the scorecard.
