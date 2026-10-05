---
id: RS-175
title: Pre-release review fixes for v1.204.0–v1.209.0
type: bug
status: in-progress
priority: P1
created: 2026-10-04
reporter: Jinhu
branch: fix/prerelease-review-v1209
pr:
version:
related: [RS-164, RS-165, RS-161, RS-176]
---

## Ask

> /code-review high all change from dev to main, and release to prod.

Asked which of the review's findings to fix before releasing, Jinhu chose
"Fix 1–4, then release (Recommended)".

## Context

`/code-review high` of `origin/main..origin/dev` covered ten commits,
v1.204.0 → v1.209.0: the Facebook fleet viewer and re-login (RS-164, RS-165,
RS-170), the sidebar second level and fold (RS-169, RS-166), and the
web-submission email thread (RS-161). Prod was on 1.203.2. The review came
back with ten unverified findings; the first four were checked against
`origin/dev` and hold:

1. **A watch socket outlived the session that opened it.**
   `apps/backend/src/vncBridge.ts` replays the WebSocket handshake through the
   app once — cookie JWT, `active`, `tokens_valid_after`, the manager guard,
   the Origin check — and then only moves bytes, with no lifetime. A manager
   deactivated, demoted or password-reset while watching kept live control of
   a worker's Facebook browser for as long as the tab stayed open.
2. **The keyboard could not open the viewer from the accounts table.** The
   account row (`FleetAccounts.tsx`) is `role="button"` and its `onKeyDown`
   `preventDefault`s Enter/Space. The Watch eye link sits inside the row, so
   Enter on the link bubbled up, was cancelled, and toggled the row instead.
3. **One failed poll blanked the email thread.** `DesktopWebSubmissionThread`
   treated any failed `GET /messages` — including a 30-second background poll
   during a redeploy — as "this backend has no thread": it dropped the
   conversation, unmounted the draft being typed, and put the header back to
   the `mailto:` link until a later poll succeeded.
4. **Every 403 from the fleet console read as a bad token.** RS-165 maps a
   facade 401/403 to a 502 so the SPA never mistakes it for a lapsed ERP
   session. It also replaced the message with "check
   COORDINATOR_API_TOKEN", so a 403 in which the facade explained itself
   lost its explanation.

## Acceptance criteria

- [x] A relayed VNC socket re-runs the handshake's checks every minute on
      the headers it opened with. A 401 (signed out, deactivated, password
      changed, token expired) closes it with code 4401; a 403 (no longer a
      manager) closes it with 1008; a 5xx leaves it for the next check.
      A re-check never mints a ticket.
- [x] The viewer makes an ordinary API call before opening every socket, so
      the handshake carries a live cookie (or the session is signed out), and
      a 4401 close reconnects by itself with control kept.
- [x] Enter on the Watch link in an account row opens the viewer; Enter on
      the row itself still expands it.
- [x] A failed thread poll leaves the conversation, the mode and the draft as
      they were; only a 404 falls back to the `mailto:` link.
- [x] A facade 401, or a 403 with no readable JSON reason (bare, or the
      Cloudflare Access HTML page), still reaches the browser as a 502 naming
      `COORDINATOR_API_TOKEN`. A 403 whose JSON carries `detail`/`error` is a
      502 carrying those words. The VNC ticket request says the same.

## Out of scope

Findings 5–10 of the same review are filed as RS-176: shutdown never
`terminate()`s an unanswered bridge, `MAX_BRIDGES` is checked after the
async admit, the pre-upstream buffer is unbounded, `attentionReason` reports
"expiring" whatever the days left, IMAP never insists on STARTTLS off 993, and
`GET /:id/messages` runs a redundant query.

## Notes

- **No socket outlives the access token it opened with.** The re-check
  replays the frozen handshake headers, so once that cookie's JWT expires
  (≤ 60 min, `TOKEN_TTL_SEC`) it 401s. That is the same bound every HTTP
  request has. The viewer turns it into a brief reconnect. Re-checking the user
  row directly would avoid the hourly cut, but it would duplicate
  `authMiddleware` and `requireManager`.
- **Why the viewer probes `/api/me` first.** The `at` cookie's `maxAge`
  equals the token lifetime, and the watch page makes one API call on mount.
  By the time a socket is cut for an expired token, the browser has usually
  dropped the cookie too. Before this fix, Reconnect sent no cookie, and the
  handshake's 401 reached the page only as a 1006 "refused", on every click.
  A socket cannot run `api.ts`'s 401 → refresh → retry itself; an ordinary
  request can.
- **The 403 decision.** The RS-165 test modelled a bad token as
  `403 {detail: 'Invalid bearer token'}`. The incident behind RS-165 was a 401,
  and that fixture now uses a 401. A 403 that explains itself is shown in its
  own words; it is still a 502 and still a warning log.
- Plan: `~/.claude/plans/nested-soaring-lemur.md`.
