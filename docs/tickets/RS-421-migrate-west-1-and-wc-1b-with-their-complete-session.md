---
id: RS-421
title: Migrate west-1 and wc-1b with their complete sessions and existing browser identity
type: task
status: in-progress
priority: P1
created: 2026-10-27
reporter: jinhu
branch: fix/west-wc1b-session-migration
pr: 944
version: facebook-tracker 0.14.10
related: [RS-394, RS-419]
---

## Ask

> pls follow the same process to migrate for the west-1, wc-1b.

> continue

## Context

The ca-3 migration in RS-419 preserved its complete Playwright state and
listing cache and restored it in one boot, without password login. Apply
that approved process to west-1 and wc-1b, one worker at a time. west-1 has
no cached identity and pins a Mac Chrome/151 user agent from its sidecar;
the current fleet image would rewrite it to Chrome/156. Preserve that
already-presented header before moving it. wc-1b uses the browser's native
user agent. Both source workers are healthy and remain running until each
handover is ready.

## Acceptance criteria

- [x] A legacy sidecar user agent can be preserved verbatim through a fleet
      claim, cached identity and the monitor's actual new_context options.
- [x] Default and native user-agent behavior remain unchanged; tests use no
      Facebook access.
- [x] Each worker's full saved state, sidecar, identity when present, and
      monitor cache are copied and verified after a clean stop.
- [ ] Each new slot uses the same account, proxy and presented browser settings,
      with no password fallback and one restored-session boot.
- [ ] Both workers report HEALTHY; stop on a checkpoint or failed restore.
- [x] Retire the old launch paths and record backups and rollback order.

## Out of scope

Other workers, global release/restarts, password logins, challenge recovery,
and enabling alerts on the dev fleet.

## Notes

Continue the same approved handover from RS-419. Existing workers keep their
images and container ids. The parent RS-394 remains open for broader cutover.

### Live outcome, 2026-10-27 UTC

wc-1b (#30) is HEALTHY as worker-60-14-1 on 0.14.10, with one restored
boot (#562), all 20 IndexedDB databases and the same proxy IP. west-1 (#15)
has its complete session and 8,493-entry cache transferred, but remains
parked at epoch 2: its original isp.decodo.com:10004 returns 503 from both
hosts. The network failure happened before any Facebook login; no login
ledger row exists for worker-60-14-4. No checkpoint was reported and no
browser retry was made. The owner was asked whether to retain the original
proxy or approve an IP change. This ticket stays in progress until west-1
can be activated safely. Backups and detailed timings are in WS-H-migration.md.
