---
id: RS-166
title: Desktop sidebar folds to an icon rail
type: story
status: done
priority: P2
created: 2026-10-04
reporter: jinhu
branch: feat/sidebar-collapse
pr: "#492"
version: 1.208.0
related: []
---

## Ask

> the side nav bar can fold.

(Sent with a screenshot of the expanded desktop sidebar.)

## Context

The desktop sidebar is a fixed 240px grid track (`.app` in
`styles/desktop.css`). It already folds to a 64px icon rail, but only on its
own, under a 900px viewport (v1.134.0). On a normal-width window there was no
way to fold it and give the ~176px back to wide tables like the PO list and
inventory.

The rail's look was written inside `@media (max-width: 900px)`, so a class
could not reuse it. It now lives in an `@container sidebar` query on the
sidebar's own width. The media query and the user's fold are two triggers that
each narrow the track and get the same rail.

## Acceptance criteria

- [x] At any desktop width a toggle in the sidebar's brand row folds it to the
      64px icon rail and unfolds it again.
- [x] The rail looks the same as the existing under-900px rail: brand mark,
      nav icons with their names on hover, the Submit `+` badge, avatar, and
      sign-out.
- [x] The choice is a server-backed preference (`sidebar.folded`). It survives
      a reload and follows the user to another device.
- [x] Under 900px the rail is still forced, and the toggle is hidden.
- [x] Box check still renders no sidebar, folded or not.
- [x] Nav links keep an accessible name in the rail (`aria-label`), so Submit
      no longer reads as "+".

## Out of scope

- A keyboard shortcut and a width animation. Neither was asked for.
- Relaxing the 1280px / 1100px page breakpoints that assume a 240px sidebar.
- The phone and vendor shells, which have no sidebar.

## Notes

Plan: `~/.claude/plans/twinkly-dazzling-avalanche.md`. A plan reviewer
weighed the alternatives:

- Duplicating the rail rules under `.app.sidebar-folded`: two copies that can
  drift, with higher specificity.
- A `matchMedia` listener: loses the CSS-only first paint under 900px.

The container query was the only option with one source and today's
specificity.

`tokens.css` loads after `desktop.css`, so a bare `.sidebar-toggle` rule loses
to `.btn`. The hide rule needs `.sidebar .sidebar-toggle`.
