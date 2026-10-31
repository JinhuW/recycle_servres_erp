---
id: RS-482
title: Accounting drawer: Review card clipped to a sliver
type: bug
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: JinhuW/queenfish
pr: "#1029"
version: 1.394.1
related: []
---

## Ask

> The ui has broken here. [screenshot: AC-1055 drawer, the REVIEW card cut
> off mid-line at "Waiting on another manager"]

## Context

The accounting entry drawer's body is a scrolling flex column
(`.modal-body`). The Review card sets `overflow: hidden` for its rounded
corners, which drops its automatic minimum height to zero, so when the
drawer's content is taller than the viewport the card was the item that
shrank: its detail line and footer were cut away and the title clipped.

## Acceptance criteria

- [x] The drawer's sections keep their natural height; the body scrolls
      instead of squeezing any of them.
- [x] The Review card shows its title, detail and footer in a drawer taller
      than the screen.

## Out of scope

—
