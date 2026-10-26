---
id: RS-415
title: Add pool accounts to the ERP fleet from the UI, with a managed proxy list
type: story
status: done
priority: P1
created: 2026-10-26
reporter: Jinhu Wang
branch: fleet/add-to-fleet
pr:
version: 1.364.0
related: [RS-394]
---

## Ask

> Build an "Add to fleet" flow in the ERP so the owner can put new Facebook
> pool accounts into ERP-fleet slots themselves (RS-394). Owner's decisions
> (2026-10-26): 4 fleet workers on host worker-60-14 against the dev ERP;
> proxies are a list managed in the ERP (first entries will be four existing
> Decodo static ISP endpoints); assignment happens in the ERP UI.

(The owner's decisions as relayed by the RS-394 orchestrator.)

## Context

Until now the only way a `fleet_slots` row came to exist was
`apps/backend/scripts/fleet-seed-slots.mjs`, run by hand with the proxy login in
the environment. The owner wants to put accounts into the fleet from the ERP:
pick a pool account, pick one of a handful of proxies the ERP keeps, and let
the host agent start a worker for it. Each Decodo static ISP endpoint is one IP
that two accounts may share.

## Acceptance criteria

- [x] `fleet_proxies` holds each proxy's full URL sealed with `FB_POOL_KEY`;
      the manager routes list, add, edit and delete proxies and never return
      or log the URL or its login.
- [x] `POST /api/fleet/slots` creates a slot for an available pool account with
      a password and 2FA key, on a proxy that has fewer than
      `max_accounts_per_proxy` (default 2) non-parked slots, with a desktop
      device generated from the account number and the proxy's timezone; the
      pool row turns `fleet` with holder `ERP fleet` and an `assigned` event.
- [x] `POST /api/fleet/slots/:no/remove` deletes a slot that is not leased and
      returns the account to `available`.
- [x] `desired.count` for a host is capped at the slots it could claim now plus
      the slots its workers hold, so the agent starts one worker per ready
      account.
- [x] The Account pool tab has "Add to fleet" / "Remove from fleet" and a
      Proxies section (en + zh).

## Out of scope

Seeding the real proxies and accounts (the orchestrator does it after merge);
any host, Railway variable or prod change.

## Notes
- **Device rule.** The coordinator's identity generator
  (`rs_coordinator/device_profiles.py`): six common desktop screens with
  their scale, viewport = screen less 111/123/133 px of browser chrome, user
  agent left to Chromium (`native: ["user_agent"]`). The ERP picks by FNV-1a
  of `fleet-device:<account_no>` (`fleetDeviceFor` in packages/shared), so a
  re-made slot is the same machine and the page can preview it.
- **Who can be added.** `available`, or `fleet` with no holder or the
  holder `ERP fleet`. The brief allowed any `fleet` account without a slot,
  but those are the coordinator's workers' accounts: adding one would put a
  second browser on a login that is still running at home.
- **desired.count** = min(capacity, max(held + claimable, highest worker
  number holding a slot)). The floor keeps the agent from removing a worker
  that holds an account (it removes every worker above `count`).
- **Proxy edits follow the slots.** A new URL is resealed into each slot on
  the proxy and a new timezone written into each device; a removed proxy
  leaves a parked slot its sealed copy.
- Verified end to end on a private local database (backend 8931, vite
  5180): add proxies, Add to fleet (account turns *In fleet*, "waiting for a
  worker"), Remove from fleet, the edit form's URL field empty, no login in
  the page.
