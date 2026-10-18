---
id: RS-294
title: Fit the worker VNC view to the browser window
type: bug
status: in-progress
priority: P2
created: 2026-10-18
reporter: jinhu
branch: fix/vnc-fit-window
pr:
version:
related: [RS-292]
---

## Ask

> fix the screen resoltions in tyhe vnc

(Sent with a screenshot of `/fleet/watch` for nyc-1. The Chromium window sits
in the top-left corner of a large black area, with a Meta CAPTCHA drawn small.)

## Context

Since facebook-tracker 0.11.0 (RS-292), the monitor image's Xvfb display has
been 1920x1080 (`SCREEN_GEOMETRY` in `ai-marketplace-monitor/Dockerfile`) so
that the largest device profile's screen fits. Playwright sizes Chromium's
window to the context's viewport plus toolbars, which is about 1288x807 for a
legacy 1280x720 device. x11vnc served the whole display, so the ERP's noVNC
viewer scaled the black margin down along with the browser.

## Acceptance criteria

- [ ] With a 1280x720-viewport device, the worker's VNC framebuffer equals the
      Chromium window (about 1288x807), with no black margin.
- [ ] A context opened with another viewport re-fits the view without
      restarting x11vnc.
- [ ] A missing x11vnc, a headless run, or a CDP failure never fails a search.

## Out of scope

- Resizing Xvfb per device. On Xvfb 21.1, `xrandr --fb` to a smaller size fails
  with BadValue.
- Changing device profiles.
- The poster and messenger containers, which serve no VNC.

## Notes

- `x11vnc -R clip:WxH+X+Y` changes the served framebuffer while x11vnc runs, in
  both directions, and calls `rfbNewFramebuffer`, so connected viewers get a
  DesktopSize update. Verified in a bookworm container.
- The fit runs in the vendored monitor's `vnc.fit_vnc_to_window`, called from
  `Marketplace.create_page` after each new context's first page. It reads the
  window bounds over CDP (`Browser.getWindowForTarget`).
