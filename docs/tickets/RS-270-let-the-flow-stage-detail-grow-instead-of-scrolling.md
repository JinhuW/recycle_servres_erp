---
id: RS-270
title: Let the flow stage detail grow instead of scrolling
type: bug
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: fix/flow-detail-height
pr: 684
version: 1.270.1
related: []
---

## Ask

> expand the hight here to make sure no need to scroll

(Screenshot: the Title gate stage on the Fleet tab's "From a search to an
alert" card, with the keyword-rule chips cut off behind a scrollbar.)

## Context

RS-265 (v1.266.1) pinned the stage detail to 300px so picking a stage never
resized the card, and a longer stage scrolled inside it. RS-269 (v1.270.0) then
moved the keyword rules into a wide chip pane, which is taller than 300px on the
search, title-gate and keyword-gate stages, so the rules hid behind an inner
scrollbar. Rule: `.ff-flow-detail` in `apps/frontend/src/styles/facebookPool.css`.

## Acceptance criteria

- [x] A stage whose content is taller than 300px shows all of it, with no
      scrollbar inside the detail.
- [x] Short stages still hold a 300px floor, so clicking between them doesn't
      shrink the card.

## Out of scope

Keeping every stage the same height. The rules pane outgrew any fixed height
worth picking, so the card now grows on long stages.
