---
id: RS-554
title: Fleet: link each account to its first CloakBrowser launch, and keep profiles different
type: story
status: in-progress
priority: P2
created: 2026-11-06
reporter: jinhu
branch: JinhuW/fleet-profile-first-launch
pr: 1121
version: 1.430.0
related: []
---

## Ask

> I hope each account can link the profit CloakBrowser first time launched for them.
>
> Also make sure all account should have a different profile.

## Context

Since RS-537 the seed, GPU and timezone live on `fb_pool_accounts` and a unique index holds seeds apart. That compares settings, not what a browser shows. Our probe got 43 distinct canvas hashes from 50 seeds, so two seeds can look alike, and nothing recorded what an account's browser really was, on which build, or checked a later launch against it. The screen was worked out again from `FLEET_SCREENS` on every re-add. #76 and #130 ran on CloakBrowser before 0224 and their seeds were never kept, so a new account could draw one.

Owner decisions (2026-11-05): keep the identity and a launch record, with no saved Chrome folder; the guarantee covers accounts on CloakBrowser, and stock accounts stay untouched. "profit" in the Ask is read as "profile".

## Acceptance criteria

- [x] A cloak worker reports what its browser showed after the preflight and before any Facebook page; the first report is stored on the account with its time, build, worker and host.
- [x] A later launch with the same fingerprint goes on; a different one parks `profile_changed`, opens no Facebook page, and only a manager's Accept clears it.
- [x] A build bump alone (user agent and build) doesn't count as a change.
- [x] A first launch that looks like another account gets a new seed, GPU and fresh claim, with no Facebook page; two racing can't both link.
- [x] An account already shown to Facebook keeps its seed on a clash, and managers are alerted.
- [x] No answer from the ERP parks `connect_failed`, so no account reaches Facebook unrecorded.
- [x] A re-add brings back the first device, even if `FLEET_SCREENS` changes.
- [x] The seeds of #76 and #130 are restored, and `fleet_slots` holds seeds unique too.
- [x] The Fleet table shows the first launch and build, and offers Accept change only when there is one.
- [x] The dev restore keeps the new columns and clears them with a colliding seed.

## Out of scope

- Saving the Chrome user-data folder: decided against; containers keep no disk and cookies and localStorage are sealed in the ERP already.
- Stock accounts: no seed to differ, and moving a live session is a device change.
- Making every new account start on CloakBrowser: that is Phase 3 of the launch plan, after the pilot.
- Whether Facebook sees these as different machines. Fingerprint's demo gave 6 visitor IDs across about 50 seeds (spikes S2 and S3); this proves difference by our own hash only, and solo exits and the fonts decision still matter.

## Notes

- Rollout, none of which restarts a running worker or logs an account in: ERP release to `main`, then tag and stage facebook-tracker 0.18.0, then raise `FLEET_CLOAK_MIN_WORKER_VERSION` to 0.18.0. Each step needs the owner's yes.
- #55, #133 and #134 record their fingerprint at their next natural boot. For #133 that becomes the baseline though it first launched earlier.
- The fingerprint key was measured on the saved S2 and S3 runs of the real binary, no new session and no key needed: all seeds distinct and every repeat stable ([note](../debug-notes/2026-11-06-cloakbrowser-spikes-s2-s3.md)). The new preflight script has run in stock Chromium only, so the first 0.18.0 image still deserves one account-free probe.
- 2026-11-07 rollout: facebook-tracker 0.18.0 tagged (monitor `9a7004e`, which also carries RS-565's seller tasks, still gated off by the ERP) and pushed as `ghcr.io/jinhuw/aimm-recycle:0.18.0@sha256:566b2ac3…`, CloakBrowser 155 baked, no key in the image or build log. Staged at 16:39 UTC, so only new containers use it. v1.443.0 raises the cloak gate to 0.18.0.
- The account-free probe of that image on `development` (no proxy, no Facebook page): seeds 48213 and 71529 both pass the preflight and report launch facts; 48213 run twice gives the same canvas and WebGL hashes, which also match its 2026-11-02 run; 71529 differs on canvas, WebGL, cores and memory.
- `build` in the launch record reads null: `RS_CLOAK_VERSION` is a build argument, not an environment variable in the image. It is outside the fingerprint key, so verdicts are unaffected; the record shows no build until the monitor reads `/opt/cloakbrowser/VERSION`.
- A redraw waits for the old lease to end before it re-claims, as a moved exit does. No Facebook page has opened by then, so it costs only those minutes.
