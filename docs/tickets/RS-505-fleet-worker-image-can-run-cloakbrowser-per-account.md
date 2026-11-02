---
id: RS-505
title: Fleet worker image can run CloakBrowser per account
type: story
status: in-review
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/damselfish
pr:
version: facebook-tracker 0.16.0 (no ERP release)
related: []
---

## Ask

> Plan how to migrate current brower agent to the cloakbrowser. Evaluate the overall benefit

> Review current fb fleet infra and create an detailed implementation plan for the development and rolling out.

> go ahead and follow the implementation plan to start development.

## Context

Every ERP fleet worker runs stock Playwright Chromium. It reports
`navigator.webdriver = true`, renders WebGL on SwiftShader and presents a
Linux platform. Its canvas, audio and font hashes are identical on every
worker built from one image, so Facebook can tell the workers are automated
and link the accounts.

CloakBrowser is a stealth Chromium binary that patches those signals and
derives a per-account hardware fingerprint from a seed. The approved plan
(`~/.claude/plans/review-current-fb-fleet-cozy-bunny.md`) ships it as **PR B**
of three:

- **A** (ERP): state history and the engine-loss baseline.
- **B** (this ticket, tracker): the monitor engine, the worker image and the
  probe.
- **C** (ERP): the switch, `POST /api/fleet/slots/:no/engine`, its guard and
  the UI.

Owner decisions on 2026-11-02:

- ERP fleet only; the homelab compose workers stay on stock Chromium.
- Windows persona.
- The free license key first, which allows one concurrent session.

This PR changes nothing for a slot whose device has no `browser_engine`.

## Acceptance criteria

**The monitor's engine.** The vendored monitor (`recycle-patches`, pinned in
`VENDOR.md`) launches the browser the device names:

- [x] Absent or `stock` launches exactly as before.
- [x] `cloak` launches the CloakBrowser binary headed, with the device's
  `cloak_seed`, `cloak_gpu`, timezone and locale and the Windows persona.
- [x] A cloak device without a seed is refused, never given a random one.
- [x] A cloak context emulates nothing (no user agent, viewport, screen,
  locale or timezone) and keeps the session, the proxy and the device cookies.

**Parking:**

- [x] A refused license (the binary's exits 76-79, at launch or later) parks
  the fleet worker `DEAD` with `{reason: "license_denied", exit_code}`.
- [x] A cloak launch that cannot start, including an image without the
  binary, parks `browser_failed` instead of exiting.

**rs_worker:**

- [x] It passes `browser_engine`, `cloak_seed` and `cloak_gpu` into
  `identity.json`.
- [x] It pins no user agent for a cloak device, in the identity or the sidecar.
- [x] It runs Xvfb at the cloak device's screen.
- [x] It lets `CLOAKBROWSER_LICENSE_KEY` through from the claim into the
  browser's environment only, never into `config.toml` or a log.
- [x] Heartbeats carry `detail.cloak_version`.

**The worker image:**

- [x] A build with `CLOAK_BAKE=1` and the `cloak_key` BuildKit secret bakes the
  binary.
- [x] Without them the image is stock-only.
- [x] The key appears in no layer, ENV, label or file: `docker history` and
  `docker inspect` count 0 for `cb_`, and the exported filesystem holds
  neither the key nor its hash.
- [x] The build flag, not the secret, separates the cached layers.

**The probe.** `scripts/fingerprint-probe.py`, run with no account and through
a credentialed proxy, shows:

- [x] Cloak has `webdriver` false.
- [x] UA, client hints and `navigator.platform` all say Windows.
- [x] Seeds A and B give different canvas and WebGL hashes.
- [x] Seed A gives the same hashes in a fresh container.
- [x] outerWidth ≥ innerWidth.
- [x] The page and `context.request` both go through the proxy.
- [x] A blocked license server ends in `license_denied` with exit 78.

The results are in
`trackers/facebook/docs/debug-notes/2026-11-02-cloakbrowser-fingerprint-probe.md`.

## Out of scope

- The ERP side: the state history (PR A), and the engine switch, its guard
  and its UI (PR C).
- Any fleet release, a pushed image, a worker restart or the canary. Those
  are the owner's, in the plan's rollout order.
- `ttf-mscorefonts-installer`, whose licence the owner has not approved.

## Notes

- **The cloak launch runs on the monitor's own Playwright.**
  `cloakbrowser.launch()` starts a second `sync_playwright()`, which Playwright
  refuses inside the first. So the launch is built from cloakbrowser 0.7.0's
  parts, and `deploy/worker-constraints.txt` pins it exactly for that reason.
- **The license key reaches the browser by name.** The monitor's `[monitor]`
  config refuses unknown keys, so `rs_worker` allows `CLOAKBROWSER_LICENSE_KEY`
  by name rather than through a template reference.
- **BuildKit cache.** BuildKit leaves a secret out of the cache key. A build
  without the key reused the baked layer, and the reverse would have shipped
  stock silently. `CLOAK_BAKE` is in the cache key, so it decides.
- **The probe found two fingerprint gaps for the owner:**
  - The font list is Linux's: Liberation, Carlito, no Segoe UI, Tahoma or
    Verdana. It is the same on every seed.
  - Under Xvfb the cloak window opens 945 px wide and unframed.
- **License egress.** The binary checks its license directly, not through the
  account's proxy, so worker hosts need egress to cloakbrowser.dev.
