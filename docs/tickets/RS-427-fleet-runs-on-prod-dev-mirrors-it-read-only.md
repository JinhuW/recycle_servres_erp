---
id: RS-427
title: Fleet runs on prod; dev mirrors it read-only
type: task
status: in-progress
priority: P1
created: 2026-10-27
reporter: jinhu
branch: JinhuW/fleet-prod-mirror
pr:
version:
related: [RS-394]
---

## Ask

> [Image #1]
>
> In the prod. It does not show the worker in the homelabd and worker host

> 1. I hope the dev fleet can connect to prod and dev is read only instead of set up everything a brand new in the prod.

## Context

Prod's Fleet page shows "No host yet" because every fleet host and worker
reports to the dev ERP: both agents (`homelab`, `worker-60-14`) run with
`FLEET_URL=https://inventory-dev.recycleservers.com`, and on 2026-10-27 prod's
`fleet_hosts`, `fleet_workers` and `fleet_slots` were empty while dev held 2
live hosts, 15 workers and 22 slots. The only row prod showed (`se-1`,
"Never reported") is a legacy coordinator worker.

Re-pointing the agents and recreating the workers would be 15 Facebook logins.
The fleet's state moves instead, and the dev Cloudflare Worker forwards the
fleet's machine traffic to prod's backend, so running containers keep their
URL and never restart:

- A worker exits only on `409 stale_epoch` or a 401 for a bad token; a 503 it
  retries (monitor `control_plane.py` `fleet_refuses`). So dev can freeze with
  503s.
- Worker tokens are HMAC'd with `FLEET_WORKER_TOKEN_KEY` and name only
  worker, account, epoch and expiry (`apps/backend/src/fleet/auth.ts`); prod
  taking dev's key keeps every live token valid.
- Host tokens are sha256 hashes on `fleet_hosts`, so they travel with the row.
- `FB_POOL_KEY` differs between dev and prod, so sealed pool, slot and proxy
  values are resealed on the way.

## Acceptance criteria

- [x] With `FLEET_ROLE=mirror`, every manager write under `/api/fleet` answers 409 `read_only`, and host and worker routes answer 503 (never 401 or 409); the mirror runs no scheduler tick or proxy probe.
- [x] With `FLEET_ROLE=mirror`, the Fleet page says the fleet runs on prod, links there, and offers no write controls.
- [x] The Cloudflare Worker forwards `/api/fleet/*` requests that carry a bearer to `FLEET_FORWARD_URL` when it is set, with that origin's proxy secret, WebSockets and the claim's `FLEET_WORKER_ENV` merge included; cookie requests stay on `BACKEND_URL`.
- [x] With `SYNC_KEEP_FLEET=0`, the nightly prod→dev sync gives dev prod's fleet with host tokens and claim tickets scrubbed, instead of keeping dev's own.
- [ ] Prod's Fleet page shows hosts `homelab` and `worker-60-14` and the same workers, heartbeats seconds old.
- [ ] The switch caused no `boot` in `rsc vault logins` and recreated no container.
- [ ] Every sealed value copied to prod opens under prod's `FB_POOL_KEY`.

## Out of scope

- Re-pointing the agents' `FLEET_URL` at prod: waits for the next worker deploy
  the owner approves; until then the dev Worker's forward carries the traffic.
- Rotating the worker-token key; `RS_ALERTS=on`.
- Prod's Cloudflare `FLEET_WORKER_ENV` secret: not needed while claims pass
  through the dev Worker; it has to be rebuilt from its source before the
  agents are re-pointed (Cloudflare cannot read a secret back).

## Notes

Plan: dev→main release (owner's yes), prod backend gets dev's
`FLEET_WORKER_TOKEN_KEY`, `FLEET_IMAGE_*`, `FLEET_COORDINATOR_URL`; cutover
(owner's yes) = dev `FLEET_ROLE=mirror`, one-transaction copy of dev's `fleet_*`
tables and slotted pool rows into prod with resealing, then the dev Worker's
`FLEET_FORWARD_URL` / `FLEET_FORWARD_PROXY_SECRET`. Rollback: unset both on dev.
Replaces the WS-F cutover runbook (`docs/superpowers/plans/2026-10-24-erp-fleet/`).

`FLEET_ROLE=mirror` rather than a new flag: the role already decides which
loops an instance runs, and a mirror runs none of them.

The copy merges the 22 slotted pool rows instead of overwriting them. Secrets
come from whichever side saved a cookie last. Status, holder and note come
from dev, except an idle slot prod marked problem or retired (#22, #24, #27
and #34, retired with the homelab on 2026-10-27). A dry run on prod
(2026-10-27, rolled back) copied 13 workers, 22 slots and 646 tasks; all 70
sealed values opened under prod's key.

Re-pointing an agent's `FLEET_URL` later recreates no worker: the agent
replaces a running container only on an image roll or an exit
(`apps/fleet-agent/src/plan.ts`).
