---
id: RS-459
title: Fleet hosts: confirm before capacity drops below running workers
type: story
status: done
priority: P2
created: 2026-10-29
reporter: jinhu
branch: JinhuW/rs-capacity-lower-warn
pr: 1001
version: 1.382.0
related: [RS-458]
---

## Ask

> help me create an warn if the fleet is lower than worker created.

Asked to clarify, the requester chose **Capacity below running workers**: "When a
manager lowers a host's capacity below the workers it runs now, warn before
saving that the agent will remove those containers (as happened to homelab-6 to
-14)."

## Context

On 2026-10-29 homelab's capacity was lowered from 14 to 8 and then to 5. The
host agent removes every container numbered above the new count, all at once
(`apps/fleet-agent/src/plan.ts`, "Extras go first and all at once"). So
homelab-6 to -14 were stopped and deleted, including live, signed-in browsers
(see RS-458). The capacity stepper on the Fleet tab's host strip saved each
click immediately, with no warning. Raising capacity again starts new
containers, and each start is a Facebook login.

## Acceptance criteria

- [x] Pressing − on a host's capacity opens a confirm dialog instead of
      saving when the new capacity would leave a **running** container
      numbered above it.
- [x] The dialog names the workers the agent will stop and remove. It says
      each running one loses its open Facebook session, and that raising
      capacity later starts new containers, each one a login.
- [x] Confirm saves the new capacity. Cancel saves nothing.
- [x] Lowering capacity that cuts only stopped containers, or none, saves
      straight away as before.

## Out of scope

- A backend guard: the API still accepts any capacity.
- A separate warning for more workers than free fleet accounts.
