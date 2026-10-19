---
id: RS-296
title: Full screen for the fleet watch view
type: story
status: in-review
priority: P2
created: 2026-10-18
reporter: jinhu
branch: feat/fleet-watch-fullscreen
pr: "#736"
version: 1.282.0
related: [RS-295]
---

## Ask

> think of how to zoom out when i taek controle of it. a full screen.

(Asked after RS-295 cropped the VNC view to the worker's browser window, while
looking at nyc-1 on `/fleet/watch`.)

## Context

`/fleet/watch/<worker>` (`apps/frontend/src/pages/desktop/FleetWatch.tsx`)
embeds noVNC in a stage `calc(100vh - 250px)` tall, beside the 340px sign-in
panel and under the shell's sidebar and page head. A CAPTCHA you clear by taking
control stays small. noVNC already scales to its container in both directions
(`scaleViewport`, `Display.autoscale`) and follows container resizes with a
`ResizeObserver`, so only the container has to change.

## Acceptance criteria

- [x] A Full screen button puts the watch card (browser and sign-in panel)
      full screen, and the remote browser scales to fill it.
- [x] Ticking Take control (from the page head or the re-login strip) also
      enters full screen; handing control back exits it.
- [x] Esc or Exit full screen leaves full screen without dropping control.
- [x] In full screen, a top bar offers status, control, Re-login, the panel
      toggle and Exit, and the re-login strip moves inside the card.

## Out of scope

- The mobile PWA.
- Zooming inside the remote Chromium (Ctrl+−). It changes what Facebook sees.

## Notes

- The Fullscreen API needs a user gesture, so full screen is entered in the same
  click handler that takes control (`changeControl`), not in an effect.
- Checked with headless Chromium against the local stack: the button, Exit,
  Take control, Esc (`document.exitFullscreen`) and handing control back inside
  full screen each behave as above.
