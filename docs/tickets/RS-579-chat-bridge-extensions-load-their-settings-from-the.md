---
id: RS-579
title: Chat bridge extensions load their settings from the ERP, and the ERP can change them
type: story
status: in-progress
priority: P2
created: 2026-11-11
reporter: jinhu
branch: feat/fb-chat-remote-config
pr:
version: 1.453.0
related: [RS-578]
---

## Ask

> update the extension to load dynamic configuration once it have an initial configuration.
>
> The ERP page can update the configuration if needed.
>
> I am not sure how many configuration it will load, But make sure ithe chrome extension is open for it.

## Context

The chat bridge extension (RS-578) keeps every setting in each Chrome
profile's options page. Changing how fast replies are typed, or stopping a
profile, means opening that profile's browser. The owner wants the extension
to need only what it takes to reach the ERP, and to take everything else from
the ERP, where it can be changed for every profile at once or for one.

The set of settings is not known yet, so the contract must not fix it.

## Acceptance criteria

- [x] With an ERP address and credentials saved, the extension asks the ERP for
      its settings (`POST /api/fb-chat/push/config`) at once and then every
      `configPollSec` (60 s by default), bridge on or off.
- [x] The request lists the settings the extension understands (key, type,
      default, bounds, label, help). The ERP keeps them per extension version.
- [x] Settings ▸ Chat bridge (managers) draws its form from those fields: a
      value for every profile, and an override per profile. Saving, or
      resetting to the default, reaches each extension on its next check.
- [x] The page shows, per profile, which settings revision it last picked up.
- [x] The ERP refuses a value that does not fit the field (type, range,
      options). A key no extension has reported yet is accepted, so the ERP can
      be set ahead of an extension release.
- [x] The extension ignores keys it does not know and clamps values to its own
      bounds; the last values it heard survive a restart and an unreachable ERP.
- [x] `paused` stops claiming and typing replies; a reply claimed just before
      the pause is reported failed, never typed late.

## Out of scope

- Facebook selectors as remote settings: they stay in the extension's
  `selectors.ts`, checked against the live page.
- Auto-updating the extension itself: asked for separately in the same
  session; how depends on whether the Macs can be enrolled in Chrome
  Enterprise Core.

## Notes

- Values are JSON. Precedence: the extension's default < the value for every
  profile < the value for one profile.
- The revision is a hash of the values one profile gets, so it changes only
  when what that profile would apply changes.
