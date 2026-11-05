---
id: RS-544
title: Fleet agent: one licence probe per host, stock first
type: bug
status: done
priority: P1
created: 2026-11-05
reporter: jinhu
branch: JinhuW/cloak-fixes-wave-2
pr: 1101
version: 1.424.4
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

Wave 2 of the CloakBrowser fix plan, review finding 3. Exit-74 retries are real
boots through the handoff path, not paced by the lease as RS-529 assumed, and each
took the host's one start in worker-number order. Simulated on the real agent with
18 cloak workers: a stock restart waited +213 to +234 minutes.

## Acceptance criteria

- [x] One exit-74 worker per host probes, the lowest number, and the rest spend no attempts.
- [x] A due stock restart takes the tick's start ahead of a probe.
- [x] An outage never holds a worker; retries continue about hourly past 8.
- [x] A probe running past 15 minutes ends the outage, and workers from before then restart one stagger apart, surviving an agent restart.
- [x] Re-running the review's simulation gives a stock restart at +11 minutes and 6 boots in a 4-hour outage, with no worker held.

## Out of scope

- Fixing the docstring at `monitor.py:1276` and launch plan line 251, which wait for wave 3 and the plan update.
- ERP screens for an outage: wave 4.

## Notes

Owner decision: probe hourly rather than hold. If spike S5 shows a probe can reach
Facebook after launch, that reverses, since each probe would then cost a login.

The vendor told one customer a running browser tolerates 30 minutes offline. If a
fresh launch can also survive 15 minutes before dying, a probe would falsely end
the outage and the rest would restart and exit 74 again. Spikes S4 and S5 decide
whether 15 minutes is long enough.

Recovery in simulation: the last worker's first boot came 104 minutes after a
4-hour outage ended (backoff wait, 15-minute proof, then 17 staggered starts).
