---
id: RS-165
title: An upstream 401 from the fleet console is read as an expired ERP session
type: bug
status: done
priority: P2
created: 2026-10-04
reporter: Jinhu
branch: fix/coordinator-upstream-401
pr:
version:
related: [RS-164]
---

## Ask

> fix the issue:

(With a screenshot of the error dialog "Something went wrong — HTTP 401 ·
GET /api/coordinator/challenges?status=open · 401 · 8d2ec954-23ad-49ed-a652-8177f243822e"
on the Facebook tracker page.)

## Context

The dialog came from the dev environment. Its `COORDINATOR_API_TOKEN` no
longer matched the fleet console's `RS_CONSOLE_TOKEN`, so the facade answered
every `/api/coordinator/*` call with 401 (30–100 ms in the Railway logs — far
past the ERP's own 1–2 ms auth refusals). The proxy passed that 401 through
verbatim, and the SPA reads a 401 from any `/api` route as a lapsed session:
it refreshed, retried, got 401 again, raised the dialog, and from 12:35:47 the
refreshes themselves were refused — a misconfigured fleet token was signing
the manager out of the ERP.

The dev token was reset from the fleet's `secrets.env` the same day; this
ticket is the code half, so the next mismatch is reported as what it is.

## Acceptance criteria

- [x] A 401 or 403 from the facade on any `/api/coordinator/*` route (JSON,
      screenshot, relogin) reaches the browser as a 502 naming
      `COORDINATOR_API_TOKEN`, never as a 401/403.
- [x] The VNC viewer says the same when the ticket request is refused.
- [x] The refusal is logged as a warning with the upstream status and path.

## Out of scope

Validating the token at boot — the facade may be down when the ERP starts,
and that must not stop the ERP.
