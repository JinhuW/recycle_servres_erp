---
id: RS-461
title: Fleet: release every parked worker's account in one click, and show freed workers as Free
type: story
status: done
priority: P2
created: 2026-10-29
reporter: jinhu
branch: JinhuW/amphipod
pr: 1002
version: 1.383.0
related: []
---

## Ask

> Add a button to clean up all parked worker by one buttom, But it will ask to confirm.

> Since these parked account can not work anymore, i would like to relase them from the worker.
> Then i can assign new account for these workers.
> Maybe you can create new status for free worker.

## Context

The Fleet tab's worker table (`pages/desktop/fleet/FleetAccountsTab.tsx`) had
15 parked workers whose accounts hit Checkpoint or Session expired. The only way
to let one go was the per-row **Retire & free** (`POST /api/fleet/slots/:no/retire`,
`apps/backend/src/fleet/workers.ts`): it retires the account in the pool and
drops its slot, and the worker is refused on its next call and exits. The host's
desired count follows the claimable slots (`workerCount`, `fleet/hosts.ts`), so
a freed worker stays down until an account is added to the fleet. Then it
starts and claims that account.

A released worker still read **Parked**, as if something were wrong with it.
Nothing is wrong with it. It has no account.

## Acceptance criteria

- [x] The worker table's toolbar has a **Release parked (N)** button. N counts
      the ERP rows the per-row Retire & free would accept. It is hidden in the
      mirror and when N is 0.
- [x] Clicking it opens a confirmation dialog. The dialog lists each account and
      its worker and state, says how many parked rows it skips, and warns that
      each account added to the fleet afterwards starts a worker, which is a
      Facebook login.
- [x] Confirming retires each listed account in turn through the existing
      `/retire` endpoint. A toast reports how many were released, any failure
      is shown, and the table reloads. Nothing runs before the confirmation.
- [x] A worker that is not running and whose account's slot is gone (retired
      or removed from the fleet) shows as a new row kind, **Free**, with its
      own legend chip and a hint about adding an account on the Account pool
      tab. Free takes precedence over Removed and Parked.
- [x] The Healthy count and the "running on K hosts" footer are unchanged.

## Out of scope

- Releasing silent workers whose account is still fine. Retiring a good
  account would waste it.
- Coordinator rows. The ERP has no slot of theirs to retire.
- Picking which account a free worker gets. The claim takes any free fleet
  slot, and accounts go into the fleet from the Account pool tab.
- A server-side bulk endpoint. The per-account `/retire` keeps its guard and
  its pool events.

## Notes

No backend change and no restart. Releasing stops the workers, and a stopped
worker starts again (a login) only once an account is added to the fleet.
