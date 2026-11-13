---
id: RS-585
title: Fix the dev → main release review findings
type: bug
status: done
priority: P1
created: 2026-11-13
reporter: jinhu
branch: fix/dev-release-review
pr: 1197
version: 1.457.1
related: [RS-581, RS-582, RS-583, RS-584, RS-586]
---

## Ask

> yes. Fix all remain.

(Answering the `/code-review high` of `origin/main...origin/dev`, v1.454.0–v1.457.0, which found ten problems.)

## Context

`dev` held four releases waiting for `main`. The review found two that should
block the release (0239 breaking the release before it, and a late send
result settling a retried reply) and eight more.

## Acceptance criteria

- [x] 0239 drops nothing the release before it reads (`fleet_slots.role`,
  `agent_on`, `agent_profile_id`, `fleet_tasks.payload`, the seller tables),
  and deletes the seller tasks' attempts with them, so their minutes do not
  count as search.
- [x] A claim carries `attempt`; a result naming an earlier attempt cannot
  fail or mark uncertain the one being typed.
- [x] A device cannot push for an account another approved device relays
  (409), and taking over an account (once its device is revoked) drops the
  name and pause chosen at approval, as approveDevice does.
- [x] Enrollment counts and inserts under one lock, holds at most 5 waiting
  requests per address and 100 in all, and forgets a request not heard from in
  an hour.
- [x] Change proxy leaves the moving account out of the IP it leaves.
- [x] The proxy health table's crowding uses the server's per-IP count.
- [x] `exitLoads` computes only the asked-for proxy's load when given one.
- [x] Chat search is served by a trigram index on message bodies.

## Out of scope

Dropping the kept seller columns and tables: RS-586, in a later release.

## Notes

0239 is edited although dev already ran it: production has not, and an edit
to an applied file only logs a warning, so dev keeps its dropped columns and
production keeps them until RS-586. Attempt rows already orphaned on dev by
the first 0239 cannot be told apart from other purged tasks' and stay.
The extension sends `attempt` back from its next release; until then results
carry none and are taken as before.
