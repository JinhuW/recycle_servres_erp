---
id: RS-279
title: Show the worker's account and live 2FA code beside the Watch browser
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-watch-account-panel
pr: 707
version: 1.276.0
related: []
---

## Ask

> update this page. i hope all the acount information can show in the side.
>
> /frontend-design:frontend-design pls design the page and create an user friendly UI UX design. cuz sometime it will need to fill the 2FA code.

(The request came with a screenshot of `/fleet/va-2/watch` showing a live
Facebook session.)

## Context

The Watch page (`apps/frontend/src/pages/desktop/FleetWatch.tsx`) shows a
worker's live Chromium. When Facebook asks for a password or a 2FA code, the
manager has had to leave the page, open the Account pool and find the login.
The only account information on the page was the login name in its back link.

A fleet worker's login is already a row in the Account pool (`status = 'fleet'`,
`holder_name = <worker>`), and a manager's `GET /api/facebook-pool` returns it
unsealed, TOTP key included. `heldByWorker()` finds the row, and `PoolCode`
already draws a live code. So no backend or tracker change is needed.

## Acceptance criteria

- [x] The Watch page shows a side panel with the worker's pool login: login,
      password (masked, reveal), email, email password, recovery, FB profile.
- [x] It shows a live 2FA code with a countdown, copyable in one click.
- [x] While in control, "Type into browser" types the code, login or password
      into the focused remote field.
- [x] The code band is highlighted while the worker is in `CHALLENGE_2FA`.
- [x] Copies, reveals and typed secrets go to the pool's activity ledger.
- [x] Worker facts (region, state, session left, heartbeat, proxy, build) sit
      in the panel.
- [x] The panel can be hidden, the choice is remembered, and it stacks under
      the stage on narrow screens.
- [x] A worker whose login isn't in the pool gets a clear message and the vault
      summary.

## Out of scope

- A TOTP endpoint on the tracker side: the pool already holds the key.
- Auto-submitting the code into Facebook.
- Editing credentials from this page: the worker page's Edit credentials does that.

## Notes

- Clipboard text doesn't reach the VNC session, which is why typing goes
  through noVNC's `sendKey`. noVNC drops keys while view-only, so typing needs
  Take control.
- The pool's events endpoint accepts only `copied` and `revealed`, so a typed
  secret is logged as `copied`.
- Verified locally with stubbed coordinator and pool responses: the layouts,
  the challenge tint, reveal, the hide toggle and narrow stacking. Keystroke
  typing needs a live VNC session, so it gets checked in prod after release.
