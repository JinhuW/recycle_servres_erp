---
id: RS-279
title: Release review findings on the Edit cities frequency form
type: bug
status: in-review
priority: P2
created: 2026-10-17
reporter: jinhu
branch: claude/project-thread-b1tn16
pr: 704
version: 1.275.3
related: [RS-277]
---

## Ask

> Prep prod release

Chosen on the thread's task card, whose consequence read: "High-effort review
of dev against main for v1.274.0, fix the findings, then wait for your go-ahead
to release."

## Context

The `/code-review high` pass over `main...dev` (RS-277 tiered city frequency,
facebook-tracker v0.8.0) returned ten findings. Six are in the ERP's Edit
cities dialog and can lose a manager's edits or another worker's pins; this
ticket fixes those. The four tracker-side findings are recorded under *Out of
scope*.

## Acceptance criteria

- [x] The dialog loads the tiers once per opening; the fleet page's 30-second refresh no longer resets unsaved pins or ranking-rule edits.
- [x] Saving sends only what this form changed: pins are re-read just before the write and only this form's edits are applied, and settings carry only the changed keys, so another manager's or another worker's pins survive.
- [x] Removing a city another worker still searches keeps its pin; removing a city nobody else searches drops it. Adding a city that is already pinned shows and keeps that pin.
- [x] A ranking rule the coordinator would refuse (empty box, out of range, top + next over 100, a tier searched more than the one above) disables Save with a note, and the tiers are written before the cities, so a refused tier write no longer leaves the city list half-saved.
- [x] The Auto option shows the searches a day the worker actually makes (capped by its start times), and an interval-paced worker gets a note that it searches every city each round instead of "0 search times".

- [x] Assign account (RS-276, #698, also in this release) refuses an account that a purchaser or another worker holds (`fpAssignHeld`), refreshes the pool after any refusal, moves every account on the worker at swap time, and labels mismatched or unreadable cookies.

## Out of scope

Tracker-side findings, each needing a facebook-tracker release and a homelab
deploy, left for a separate decision:

- `search-plan` re-runs the 30-day alert aggregate on every call; a short cache would cut it.
- The rank can change between items of the same slot, so items in one slot may get different city sets (the docstring claims otherwise).
- The console's fleet poll asks for the rank after its other stats calls rather than alongside them, so a slow coordinator doubles the poll's wait.
- From the #698 review, not fixed: the vault write and Re-login still happen before the pool transaction, so a DB failure after them leaves the pool behind the vault (pre-existing in the assign route); `PUT /api/coordinator/accounts/:id` has no ERP caller left but is a tracker contract route; the "replaced by #N" audit detail is English; the previous-fate list and the candidate sort are duplicated between files.
- The console matches ranked rows to config slugs case-sensitively while the coordinator lowercases; every slug written by the ERP or in `master.toml` is lowercase today, so it is not reachable.
