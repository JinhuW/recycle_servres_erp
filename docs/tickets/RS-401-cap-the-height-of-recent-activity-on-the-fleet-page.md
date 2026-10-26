---
id: RS-401
title: Cap the height of Recent activity on the fleet page
type: bug
status: done
priority: P2
created: 2026-10-25
reporter: jinhu
branch: JinhuW/clownfish
pr:
version: 1.349.1
related: []
---

## Ask

> set an max hight for this recent activities.

Asked whether the existing 320px cap was too tall or not working:

> It doesn't scroll for me

## Context

The Recent activity aside on Monitors ▸ Facebook ▸ Fleet (`ActivityAside` in
`apps/frontend/src/pages/desktop/FleetWorkers.tsx`) only had a height cap below
1190px, where `.ff-activity .fp-log` gets `max-height: 320px`. Above that width,
`.ff-split > .ff-activity` stretches to the Workers card's row height. With a
full fleet the Workers card is thousands of pixels tall, so the feed grew with
it and never scrolled. A harness with the real stylesheets confirmed it: at
1300px wide beside a 2400px Workers card, the aside was 2398px tall and its list
had nothing to scroll.

## Acceptance criteria

- [x] Above 1190px the aside is at most 560px tall. Extra events scroll inside
  its list.
- [x] Beside a Workers card shorter than that, the aside still matches the
  card's height.
- [x] Below 1190px the existing 320px cap on the list still applies.

## Out of scope

Limiting how many events the feed holds, and changing the stacked layout's
320px cap.

## Notes

560px is the cap the worker page's History card (`.ff-worker-layout >
.ff-history`) already uses.
