---
id: RS-273
title: Folded sidebar shows one green + on Submit order
type: bug
status: done
priority: P3
created: 2026-10-17
reporter: jinhu
branch: fix/sidebar-single-plus
pr: 690
version: 1.271.2
related: []
---

## Ask

> The nav bar in the side should just show one +.
> [Image #1]
>
> i prefer the green + icon

## Context

On the folded desktop sidebar (the 64px icon rail, v1.134.0 / v1.208.0), the
Submit order entry (`submit` in `apps/frontend/src/lib/desktopNav.ts`) rendered
two pluses: its nav icon (the `submit` icon is a plus) and its `badge: '+'`
pill in the accent-soft green. The rail CSS hides labels but kept both.

## Acceptance criteria

- [x] On the folded rail (manual fold or under 900px), Submit order shows only
      the green `+` badge.
- [x] Other rail entries are unchanged.
- [x] The expanded sidebar is unchanged.

## Out of scope

The expanded sidebar: the icon holds the icon column the other labels align
on, and the badge sits at the right edge, so the two don't read as a pair.

## Notes

One rule in the `@container sidebar` rail block of `styles/desktop.css`:
`.nav-item:has(.badge) .nav-icon { display: none; }`. Submit order is the only
entry with a badge.
