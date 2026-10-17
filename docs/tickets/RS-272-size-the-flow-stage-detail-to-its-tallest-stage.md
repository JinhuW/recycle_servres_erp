---
id: RS-272
title: Size the flow stage detail to its tallest stage
type: bug
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: fix/flow-detail-max-height
pr:
version: 1.271.1
related: [RS-265, RS-270]
---

## Ask

> But it should have a fixed hight based on the max hight of all cards.

(Follow-up to RS-270, whose ask was "expand the hight here to make sure no need
to scroll".)

## Context

RS-270 (v1.270.1) made the stage detail on the Fleet tab's "From a search to an
alert" card a 300px minimum, so long stages grew the card. That stopped the
inner scrolling but brought back the resizing RS-265 had removed: clicking
between stages moved the page. The detail should be one fixed height for every
stage, the tallest stage's.

## Acceptance criteria

- [x] Every stage's detail is the same height, the height of the tallest
      stage, so picking a stage never resizes the card.
- [x] No stage scrolls inside the detail.
- [x] The height follows the content (more rules, a longer prompt) with no
      hard-coded number.

## Out of scope

The Edit form still sizes to itself: only the stage being edited renders while
it is open. Switching the item tab inside a rules stage can still change the
height, because the hidden stages show the same item as the visible one.

## Notes

`FlowCard` renders every stage's detail into one grid cell and hides all but
the picked one (`visibility: hidden`, `inert`), so the browser sizes the cell to
the tallest. No measuring in JS.
