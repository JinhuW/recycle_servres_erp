---
id: RS-480
title: Account pool editor: Save does nothing on fleet accounts with a saved session
type: bug
status: done
priority: P1
created: 2026-10-31
reporter: jinhu
branch: JinhuW/shovelnose-2
pr:
version: 1.393.1
related: []
---


## Ask

> deug the reason that account pool show it is in the homelab-7, But it does not show in the fleet page

> also i can not update the account status

> #128

> i clicked the save change buttom It does not works at all

## Context

Pool account #128 could not be saved from the account editor: clicking Save
changed nothing and showed nothing.

- An ERP fleet worker's `PUT /session` (`apps/backend/src/fleet/claim.ts`)
  stores the browser's whole storage state, cookies plus origins, as JSON in
  the pool's cookie field. #128's was 34,970 characters; `FB_POOL_FIELD_MAX`
  allows 8,000. The editor sends the stored cookie back on every save, so
  `validateFbPoolDraft` refused it with `fpTooLong`, in the browser and again
  in `PUT /api/facebook-pool/:no`. Every account a fleet worker has resealed a
  session for was uneditable.
- The refusal was rendered at the top of the drawer's scrolling body, while
  Status and Save sit at the bottom, so it was never seen.

The homelab-7 half of the ask is not a bug: the liveness check moved #126–#128
to `problem` at 15:25 UTC on 2026-10-31, which fenced their slots; the host's
count is 6, so its agent removed the stopped containers 7–9, and the Fleet
table drops a removed worker by design. A problem row keeps its holder to name
where the account failed.

## Acceptance criteria

- [x] Saving an account whose cookie is unchanged succeeds whatever its length;
      the status change persists and the cookie and its date are kept.
- [x] A new or edited cookie over 8,000 characters is still refused with
      `fpTooLong`, in the browser and on the server.
- [x] A save the editor refuses scrolls its error into view.
- [x] Backend test: `PUT /api/facebook-pool/:no` on a row with a stored cookie
      over 8,000 characters succeeds unchanged and is a 400 when changed.

## Out of scope

- Raising the 8,000 limit or trimming what `PUT /session` stores.
- Labelling a problem row's holder as a past worker ("was on homelab-7").
- Showing removed workers on the Fleet page.
