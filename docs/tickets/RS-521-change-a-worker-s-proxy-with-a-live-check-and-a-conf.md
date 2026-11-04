---
id: RS-521
title: Change a worker's proxy, with a live check and a confirmation
type: story
status: done
priority: P2
created: 2026-11-04
reporter: jinhu
branch: JinhuW/worker-proxy-change
pr: 1080
version: 1.415.0
related: []
---

## Ask

> Create an feature to update the proxy for a worker, but it must ask the user to confirm the change.
>
> cuz some proxy may not reliable.

## Context

A fleet slot's proxy is set once, by Add to fleet (`POST /api/fleet/slots`).
The only way to move an account off a bad exit was to edit the proxy's URL,
which moves every account on it, or to park, remove and re-add it, which throws
away its browser device. Exits do go bad: the Proxies tab tracks each one's
health (RS-424), and Add to fleet refuses a down one (RS-514).

A worker reads its proxy only when it claims a slot (`fleet/claim.ts`), so
writing the slot restarts nothing and causes no login by itself. The move
happens at the worker's next normal start, and that start is a sign-in from a
new IP, which is the risk a manager has to accept knowingly.

## Acceptance criteria

- [x] An ERP-fleet worker's page offers **Change proxy** for the slot it holds, or for a parked one no worker holds. A dev mirror does not offer it.
- [x] The dialog lists the other proxies with load and health; a full or down one is disabled.
- [x] Going on from the pick runs a live check of the chosen proxy, and nothing is written yet.
- [x] A second screen shows current and new proxy, the live check, the browser clock change, the risk and when the move takes effect. Only its confirm button writes.
- [x] A proxy that failed its live check cannot be confirmed; a slow one, or one the check could not reach a verdict on, warns.
- [x] `POST /api/fleet/slots/:no/proxy` refuses a call without `confirm: true`, so no client can skip the question.
- [x] The call names the proxy the manager saw, and is refused with `proxy_changed` when the slot has moved since.
- [x] The backend refuses a same, missing, full or down proxy, and changes nothing.
- [x] The write copies the sealed URL and the proxy's timezone to the slot, keeps the rest of the device, and does not touch the lease, the epoch or the worker.
- [x] The account's pool log records who moved it, from where to where, with no proxy login.
- [x] The worker page says when the running browser still goes out through the old proxy.

## Out of scope

- **Homelab workers.** Their proxy lives in `config.toml` on the VM and only a container restart reads it, which is a login. This is ERP-fleet slots only.
- **Moving a running worker now.** Nothing restarts or signals it. Forcing the move would be a login the first rule of this repo forbids without a reason.
- **A bulk move.** One account, one decision.

## Notes

- Drafted without a plan-mode stop: the request came as a `/goal`, which runs without pausing. The owner reviews the result on `dev`.
- A failed live check blocks in the dialog only. The backend applies the same `down` rule as Add to fleet, where one miss after a good check is a `degraded` blip.
