---
id: RS-520
title: A Free fleet worker shows no account or browser it does not have
type: bug
status: done
priority: P2
created: 2026-11-04
reporter: jinhu
branch: fix/free-worker-truth
pr: 1078
version: 1.414.4
related: []
---

## Ask

> fix the free workers.
>
> figure out why they have account, But seem the browser does not serve any account.

## Context

On 2026-11-04 the Workers table listed 8 Free workers, each with an account
number, "Waiting for a task" and a VNC port. None of them held that account.
Accounts 76, 87, 88, 89, 90, 91, 103 and 105 (with 30, 83 and 85) were retired
at 05:02:53–54 UTC under the owner's login, about 100 ms apart, which matches
Release parked. Their slots were deleted, and each worker was refused and
exited 75. `homelab-7` to `-10` were then removed, `worker-60-14-9`, `-11` and
`-12` stayed exited with `no free slot`, and `homelab-6` claimed No. 129.

The page got this wrong in `fleetRows.ts`: `no` falls back to
`worker.account_no`, and a heartbeat under 15 minutes reads as running. Free
rows date from RS-461, RS-469 and v1.388.0. The host agent already reports each
container's state every 30 s.

## Acceptance criteria

- [x] A Free worker whose host report shows its container not running reads as not running at once: no `vnc`, no "Waiting for a task".
- [x] A Free worker whose container the host no longer reports leaves the table at once, not after 15 minutes.
- [x] With no host report, or a container still running, a Free worker keeps today's heartbeat reading.
- [x] The Account cell of a Free worker shows a dash and "was No. 87", without the account brief, and sorts as empty.
- [x] The Now cell of a Free worker never says "Waiting for a task": it says "Stopping" while the container runs, "No account" after.
- [x] English and Chinese strings; row tests; `docs/FEATURES.md` cites the version.

## Out of scope

- Adding accounts to the fleet. Each one is a login, and the only 9 available
  come from Order 2822048, whose last claims failed. This is the owner's decision.
- The down Decodo ports `:10007` and `:10008`, and the workers parked on them.
- The worker's log line "another worker holds the account", also printed for a
  retired account. A monitor change means a new image.
- Releasing to `main`.

## Notes

Display only: no worker restart, login, image or backend change. A retry with
no free slot exits before a browser opens (`rs_worker: no free slot; exiting
75`), so idle workers retrying are not logins.
