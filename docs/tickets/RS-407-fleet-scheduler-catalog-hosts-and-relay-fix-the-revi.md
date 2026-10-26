---
id: RS-407
title: Fleet scheduler, catalog, hosts and relay: fix the review findings
type: bug
status: done
priority: P1
created: 2026-10-26
reporter: Jinhu Wang
branch: fleet/fix-scheduler-hosts
pr: 918
version: 1.356.0
related: []
---

## Ask

> Owner's go-ahead: fix every finding in your review (1–16, high to low). Your read-only restriction is lifted for this.

## Context

A review of the ERP fleet's scheduling, catalog, host and relay code
(`apps/backend/src/fleet/{scheduler,tasks,cities,hosts,vnc}.ts`, the routes,
the scripts and the Cloudflare Worker) found sixteen defects, ranked high to
low. The worst: a rollout chose workers the agent never replaces (a stopped
or held container, a worker parked DEAD or on a checkpoint), so one broken
worker failed every release, and rebooting a parked account is a Facebook
login. The fleet-agent (RS-405), claim core and worker fixes run in parallel
in their own tickets.

## Acceptance criteria

- [x] A roll skips held, non-running and parked workers with a reason in `release.skip_reasons`, and finishes `done` around them.
- [x] A host report keeps only `<host>-<n>` workers plus `hold`, `exit_code`, `image_id` and the agent identity; a second live agent instance for a host gets `403 agent_conflict` on desired and report.
- [x] Removing a host frees its replacement reservations and drops its pending replacement.
- [x] A manual search on a switched-off or unverified city survives reconcile; concurrent manual tasks write one.
- [x] Enabling a city needs a matching verdict; `reverify` sends a city back for a fresh check.
- [x] A per_day change moves the pair's waiting cadence task.
- [x] A verify-slug check that ends without a verdict backs off (15 min doubling to 6 h over the last day).
- [x] Task history reads newest first, up to 5000, with `X-Fleet-Truncated`.
- [x] The quarantine rule is set-based, treats `stopped: false` as finished, and the done-by-pair reads have an index.
- [x] The fleet VNC relay is served by the advisory-lock holder only (others 503) and revalidates parked worker sockets every 60 s (`4409` on a stale epoch).
- [x] `fleet-import.mjs` keeps managers' edits unless `--overwrite`; it, `fleet-seed-slots.mjs` and `fleet-fake-worker.mjs` refuse a remote target without an opt-in; the import dry run reports search keys the way the write merges them.

## Out of scope

- Finding 7 (a DEGRADED heartbeat does not extend the task lease) and finding
  10 (every next-task locks the release row): both live in `claim.ts`, which
  the claim-core fixer owns.
- The `/stopped` handler (claim-core fixer); it does not check the agent instance.
- A retention policy for `fleet_tasks` / events: history feeds Analysis, and
  how long to keep it is the owner's call.
- Cross-instance VNC pairing: one relay instance is enforced and documented instead.

## Notes

CONTRACTS §5, §6, §7 and WS-F carry the protocol changes. Migration
`0209_fleet_review_fixes.sql` adds the done-by-pair index and the
`fleet_hosts.agent_*` columns.
