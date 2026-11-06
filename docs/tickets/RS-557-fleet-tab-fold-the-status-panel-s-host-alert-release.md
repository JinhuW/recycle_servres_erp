---
id: RS-557
title: Fleet tab: fold the status panel's host, alert, release and engine rows
type: story
status: done
priority: P2
created: 2026-11-06
reporter: jinhu
branch: JinhuW/fleet-rack-fold
pr: 1128
version: 1.433.0
related: []
---

## Ask

> Update this part as foldable.

(With a screenshot of the Fleet status panel's host rows, held-worker alert,
Release row and Browser engine row.)

## Context

`FleetRack` (RS-553, v1.429.0) folds each host's and the engine's controls, but
the rows themselves always show above the workers table.

## Acceptance criteria

- [x] An arrow in the panel's top row folds the host, alert, release and engine rows together
- [x] The headline, "things need you", filter and page actions stay visible when folded
- [x] The panel opens unfolded until a user folds it
- [x] The choice is saved per user and survives a reload
- [x] Unfolding restores any host fold or alert detail left open

## Out of scope

Keeping a failed release visible while folded, changing what the headline counts,
the per-host folds, the other Fleet tabs, the mobile shell.
