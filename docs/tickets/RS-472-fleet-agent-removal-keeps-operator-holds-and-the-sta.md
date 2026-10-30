---
id: RS-472
title: Fleet-agent removal keeps operator holds and the stagger
type: bug
status: done
priority: P2
created: 2026-10-30
reporter: jinhu
branch: ticket/fleet-agent-remove-review
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1015
version: 1.389.1
related: [RS-470]
---

## Ask

> check this codex comments
>
> - [P2] Persist operator holds for workers above the count — apps/fleet-agent/src/plan.ts:247-249
>   When an operator stops an old-image worker already above desired.count, holdOf initially prevents removal, but this loop never persists the detected operator_stopped hold. After an agent restart, bootAt is newer than the stop, so holdOf returns null and cleanup deletes the deliberately stopped container. Persist newly detected holds for extras, as the within-count branch does, so restarting the agent preserves the manual-stop protection.
> - [P2] Preserve the observed start timestamp before removal — apps/fleet-agent/src/agent.ts:284-285
>   If a recently started extra exits on an old image and its start is absent from memory.last_start_at—for example, after docker start by an operator—cleanup deletes the only record enforcing the stagger. The next tick no longer sees that start and can launch a missing worker prematurely. A reproduction starts another worker only 40 seconds after the previous start despite a 180-second stagger. Persist the effective latest start before removal without recording removal as a new start; worker starts are Facebook logins (AGENTS.md:22–25 (AGENTS.md#L22-L25)).
>
> to see if it need a fix , if yes. then go ahead and fix them.

## Context

RS-470 (v1.388.0) let the fleet-agent remove a stopped worker above the
count when it is on an old image. Two things that only lived on the
container were lost with it:

- A stop by hand (exit 0/143 while the agent ran) is recognised by comparing
  the exit with the agent's boot time. Within the count that hold is written
  to `memory.held`; above it, it was not, so a restarted agent saw an exit
  from before its boot, read it as a host shutdown, and removed the container.
- The stagger counts from the later of `memory.last_start_at` and the newest
  `started_at` Docker shows. A start the agent did not make (`docker start`
  by a person) exists only on the container, so removing it moved the
  stagger back, and the next start (a Facebook login) could come early.

## Acceptance criteria

- [x] A stop by hand on an extra is remembered as a hold, and a restarted
      agent does not remove that container.
- [x] Before removing a container, the agent writes the effective latest
      start to memory when it is newer than the remembered one; the removal
      itself stamps no start. If that write fails, nothing is removed.
- [x] A start made by hand on an extra, 40 s before its removal, still
      holds the next start back for the full stagger.

## Out of scope

—
