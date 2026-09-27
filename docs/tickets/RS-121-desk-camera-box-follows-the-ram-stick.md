---
id: RS-121
title: Desk camera box follows the RAM stick
type: story
status: in-progress
priority: P2
created: 2026-09-27
reporter: jinhu
branch: feat/desk-cam-follow-box
pr:
version:
related: [RS-119, RS-120]
---

## Ask

> pls adjust the box inside the camera.
>
> [Image: live desk camera — the RAM stick runs past the fixed dashed box]

> (Asked how the box should behave, chose: "Follow the stick — the box snaps
> around the detected green stick live, exactly what will be cropped and sent.
> Focus/stillness are judged on the stick itself. Falls back to a large
> default box when no stick is found.")

## Context

The dashed box was the trigger's fixed 960×540 centre crop. Since RS-120 the
capture crops the stick by its green PCB, but the box on screen didn't show
that, and focus/stillness were still judged on the fixed crop — a stick placed
off-centre or longer than the box was judged mostly on paper.

## Acceptance criteria

- [ ] The box wraps the detected stick live (solid border) and glides with it.
- [ ] With no stick found, a large dashed default box shows instead.
- [ ] Focus and stillness are judged inside the box the user sees.
- [ ] A still stick is scanned once; moving it to a new spot, or swapping in
      the next stick, re-arms the trigger.
- [ ] Detection that misses a frame or two doesn't make the box flicker.

## Out of scope

Rotated boxes, and detecting non-green PCBs.
