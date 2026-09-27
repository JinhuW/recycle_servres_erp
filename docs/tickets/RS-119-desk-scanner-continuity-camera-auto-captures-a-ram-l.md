---
id: RS-119
title: "Desk scanner: Continuity Camera auto-captures a RAM label into the line drawer"
type: story
status: in-progress
priority: P2
created: 2026-09-26
reporter: jinhu
branch: feat/desk-scanner
pr:
version:
related: [RS-116]
---

## Ask

> I would like to use Iphone to build an desk scanner. Once the ram with clear characters detect uder the camera.
>
> It will auto recognize the info and fill the form.
>
> [Image: a ring light on a swing arm with a phone clamp, over a desk]

> it will use the continue camera feature.

## Context

The iPhone sits face-down on a ring-light swing arm over the desk and acts as
the Mac's webcam through Apple Continuity Camera. The desktop PO line drawer
could only take a dropped or picked file, so every stick meant a photo, a
transfer and a drag. The scan endpoint, OCR and field mapping already exist;
what was missing is a live camera in the drawer and a trigger that decides, in
the browser, when a frame is worth sending.

## Acceptance criteria

- [ ] The desktop line drawer (New PO and Edit PO) has a Camera button next to
      the AI label dropzone that opens a live camera preview in its place.
- [ ] The iPhone Continuity Camera is picked automatically (not its Desk View
      device); the chosen camera can be switched and is remembered.
- [ ] With a RAM label held still and in focus under the camera for about a
      second, the frame is captured and scanned with no click, and the line's
      fields fill exactly as a dropped photo would.
- [ ] An empty desk, or a hand/stick still moving, never triggers a scan. A
      still scene is scanned once; the next scan needs the scene to change.
- [ ] After a readable scan the camera closes, so swapping sticks can't
      overwrite the line. An unreadable scan keeps it open for a retry.
- [ ] "Open camera automatically" makes every new line's drawer start with the
      camera live, so a pallet goes stick → fields → Confirm → next line.

## Out of scope

The phone camera flow, client-side OCR, and any backend scan/OCR change.

## Notes

Plan: `~/.claude/plans/happy-juggling-dusk.md`. RS-117/RS-118 were taken by
peer sessions at filing time, hence RS-119.
