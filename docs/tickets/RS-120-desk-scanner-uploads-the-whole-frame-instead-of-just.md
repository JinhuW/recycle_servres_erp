---
id: RS-120
title: Desk scanner crops the RAM stick out of the camera frame
type: bug
status: done
priority: P1
created: 2026-09-27
reporter: jinhu
branch: fix/desk-scanner-box
pr: "#420"
version: 1.184.1
related: [RS-119, RS-109]
---

## Ask

> [Image: a captured frame — RAM stick small in the middle of desk, cloth, paper and a hand]
>
> i can see the camera take a lots of noise area instead of only the content in the box.

> i am fine with the full camear content is used for the AI or label content recognization.

> help me auto tailoring the ram in the full picture.

## Context

The first real run of the RS-119 desk scanner uploaded the whole Continuity
Camera frame: the stick small in the middle, surrounded by a black cloth, a
wooden desk, paper and a hand. The full frame is acceptable to OCR, but the
stick should be found and cropped out automatically wherever it lies.

The sheet segmenter (RS-109) can't be pointed at a camera frame as-is: its mask
is "anything that isn't white paper", which on a desk marks the cloth, wood and
hand too. The PCB's green is what tells a stick apart from a desk.

## Acceptance criteria

- [x] A capture finds the green PCB anywhere in the frame and uploads a crop of
      just the stick, padded so the gold fingers and label edges survive.
- [x] A portrait stick is turned so its label reads left-to-right.
- [x] A label spanning the stick's full height doesn't split it into two crops.
- [x] No green stick found (other PCB colours, a steeply tilted stick) → the
      full frame is uploaded, as before.

## Out of scope

Non-green PCBs and deskewing a tilted stick.
