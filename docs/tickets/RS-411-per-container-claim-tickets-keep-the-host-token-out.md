---
id: RS-411
title: Per-container claim tickets keep the host token out of fleet workers
type: story
status: done
priority: P2
created: 2026-10-26
reporter: jinhu
branch: fleet/claim-tickets
pr: "#924"
version: 1.360.0
related: []
---

## Ask

> complete all remaining

(The owner's approval of the deferred review finding, relayed with it:)

> The agent passes RS_FLEET_HOST_TOKEN into every worker container and the worker claims with it. A compromised worker container (it runs Chromium on Facebook) can claim any free slot on its host and receive its plaintext password/TOTP/cookies, and can fence siblings via /hosts/:id/stopped.

## Context

Fleet review follow-up (parent RS-394). Every worker container runs a logged-in
Chromium on Facebook. With the host token in its environment, one compromised
container could claim every free account on its host, read their passwords,
TOTP seeds and cookies, and confirm its siblings "stopped" to fence them.

## Acceptance criteria

- [x] `POST /api/fleet/hosts/:id/tickets {worker_id, handoff_epoch?}` (host
  scope) answers `{ticket, expires_at}`: a random single-use ticket bound to the
  host, worker id and handoff epoch, stored hashed, 10 minutes to live.
- [x] `POST /api/fleet/worker/claim` accepts the ticket as its bearer; the first
  successful claim spends it atomically, a retry with the same `claim_id`
  within its life gets the same answer, anything else is `401 used_ticket`;
  another worker id or handoff epoch is `401 ticket_mismatch`; an expired one
  `401 expired_ticket`.
- [x] A ticket reaches no host route (`desired`, `report`, `stopped`, `tickets`).
- [x] The agent mints a ticket right before each `docker run` and passes it as
  `RS_FLEET_CLAIM_TICKET` (and, for older worker images, as
  `RS_FLEET_HOST_TOKEN`); the host token never enters a container. No ticket,
  no start.
- [x] The worker claims with `RS_FLEET_CLAIM_TICKET` when present, else
  `RS_FLEET_HOST_TOKEN`; a refused ticket exits 75 before the browser.
- [x] The host token keeps working on `claim` for one release (deprecated for
  workers): old agent + new backend, old agent + new worker, new agent + old
  worker all claim.

## Out of scope

Removing host-token claims (the next release, once every host runs the new
agent). Deploying the new agent to a host.

## Notes

- `docker start` on a ticket container claims with a spent ticket, so the
  container carries `rs.fleet.claim_ticket=1` and is recreated (stop
  confirmation, fresh ticket, `docker run`) like a handoff container; offline
  the agent does not `docker start` it. Online with `leases` it already
  recreated every exited worker, so nothing changes there.
- Minting a ticket voids the worker's older tickets and sweeps expired ones.
- Contract: CONTRACTS.md §2, §3, §4, §5, §6, §10.
