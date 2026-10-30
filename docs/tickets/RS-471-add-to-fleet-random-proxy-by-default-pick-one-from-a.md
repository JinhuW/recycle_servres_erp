---
id: RS-471
title: Add to fleet: random proxy by default, pick one from a dropdown
type: feature
status: done
priority: P2
created: 2026-10-30
reporter: jinhu
branch: JinhuW/cormorant
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1014
version: 1.389.0
related: []
---

## Ask

> Update this add to fleet operation.
> Radom by defaut or select from proxy.
>
> I hope the UI can be simple

(With a screenshot of the "Add #125 to the fleet" dialog, whose proxy list of
radio cards wrapped each label over several lines.)

## Context

The Account pool's Add to fleet dialog listed every proxy as a radio card with
its label, exit, timezone and load in five columns. At 560px the label column
squeezed to a few characters, so each card wrapped over three or four lines and
the list ran past the fold. Most of the time the manager does not care which
proxy an account lands on, only that it has room.

## Acceptance criteria

- [x] The proxy is one dropdown. Its first option, "Any proxy with room (random)", is selected by default.
- [x] Below it, every proxy is one option showing its label and its load ("0 of 2 accounts"). A full proxy is listed but disabled.
- [x] Adding with the random option puts the account on a proxy picked at random from those with room, and the toast names that proxy.
- [x] Picking a proxy shows the browser line (screen, scale, timezone) for it, as before.
- [x] With no proxy that has room, the dialog says so and Add to fleet is disabled.

## Out of scope

Server-side random choice. The client picks among the proxies it was shown, and
the backend's `proxy_full` 409 still guards a race.
