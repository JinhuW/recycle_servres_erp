---
id: RS-547
title: Fleet: cleanup after the CloakBrowser review
type: chore
status: done
priority: P3
created: 2026-11-05
reporter: jinhu
branch: JinhuW/cloak-fixes-wave-5
pr: 1104
version: 1.425.1
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

Wave 5 of the CloakBrowser fix plan: two query costs and the review's cleanup items.
It doesn't block the pilot. The launch plan also gets the design the fixes changed.

## Acceptance criteria

- [x] A proxy round and a Proxies tab poll look up each port instead of sorting 14 days of checks.
- [x] The "last exit of a proxy" lookup, the CloakBrowser seat gate, the pilot name rule and the exit text each have one implementation.
- [x] The cohort table's first-claim time is in office time.
- [x] A port shows one note when its exit moved, not two.
- [x] The launch plan, `DATABASE.md` and RS-535 match what the code does.

## Out of scope

Reviewed and deliberately left, with the reason:

- `workers.ts` three stores for one profile: a refactor mid-launch risks more than it saves.
- `expected_exit_ip` and `webrtc_ip` as two fields: harmless, and removing one needs another pin move.
- `ENGINE_LOCK` waits: theoretical until a bulk add exists.
- `sellOrders.ts` native total copies: all spellings agree, and a SQL fragment can't replace the JS reduce. Not worth touching sell orders for.
- `engine` on `POST /slots`: the verifier called it the owner's decision, since the plan and RS-537 specify it.
- Unused cohort fields: `searches.unflagged` may be a missing column rather than waste, since the plan wants results with and without flagged accounts.
- `?? ''` fallbacks and small aliases: they exist for TypeScript, and no reader is misled.

## Notes

Measured on Postgres 18.6 with 157,248 synthetic check rows on 39 ports: latest check
378 to 416 ms before, about 4 ms after; round baselines about 431 ms before, about
2 ms after; `GET /api/fleet/proxies/health` about 31 ms end to end. Prod's data will
differ. The whole backend suite also passes locally on Postgres 18.
