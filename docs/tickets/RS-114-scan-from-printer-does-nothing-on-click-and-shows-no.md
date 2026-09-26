---
id: RS-114
title: Scan from printer does nothing on click, and shows no progress while it works
type: bug
status: done
priority: P1
created: 2026-09-26
reporter: jinhu
branch: feat/ram-sheet-scan-progress
pr:
version: 1.180.0
related: [RS-109]
---

## Ask

> i clikced the scan form printer, But it has no response.

> help me improve the UI of scan from printer. It should have interactive UI while it is working.

## Context

RS-109's Scan RAM sheet dialog put its **Scan from printer** and **Upload scan image** buttons directly inside an `.ai-dropzone` div. `tokens.css` makes every child of `.ai-dropzone` `pointer-events: none`, so a real mouse click lands on the div and does nothing. This was confirmed in Chrome on inventory-dev, where `elementFromPoint` on the button returns the dropzone. The RS-109 smokes clicked with `el.click()`, which ignores CSS, so they passed.

Separately, the bridge health check ran only when the dialog opened. The page's only feedback during a ~11 s scan plus the per-label AI reads was one line of grey text.

## Acceptance criteria

- [x] A real mouse click on **Scan from printer** and **Upload scan image** works.
- [x] Clicking **Scan from printer** re-checks the scanner bridge instead of being disabled by an old check. While the bridge is down, the dialog re-checks on its own every 5 s and on window focus.
- [x] While working, a step row (Connect → Scan page → Find sticks → Read labels) shows where it is:
  - scanning shows a sweeping page, elapsed seconds and an estimate bar
  - finding shows the page with numbered boxes
  - reading shows an overall k/N bar, a pulsing box per stick being read, and placeholder rows that fill in
- [x] **Cancel scan** stops the scan, and the bridge deletes the printer job.
- [x] Failures show a card that says what to do: bridge not running, printer asleep, scanner busy, cancelled.

- [x] Clicking a stick's picture opens it full size. This was added mid-way at the user's request: "when i click the image, It should also be able to zoom out."

## Out of scope

Row↔box hover linking, staggered animations, auto-retry countdowns.

## Notes

Bridge side (`auto_ram_scanner`): a client disconnect aborts the running eSCL job, and JSON errors carry a `kind`.
