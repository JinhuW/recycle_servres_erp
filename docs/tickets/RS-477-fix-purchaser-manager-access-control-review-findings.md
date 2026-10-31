---
id: RS-477
title: Fix purchaser/manager access-control review findings
type: bug
status: done
priority: P1
created: 2026-10-31
reporter: jinhu
branch: fix/acl-review
pr: 1023
version: 1.391.2
related: []
---

## Ask

> Pls fan out agents to review all current access control for purchaser and manager. Make sure it is well guarden.

> yes. go ahead and fix all these issues

## Context

Six parallel read-only reviews covered every backend route, MCP/OAuth, the
fleet and tracker proxies, and the frontend's role gates. No critical or high
issue: every manager-only area checks the raw role server-side, the role is
read from the DB per request, and `rolePreview` can only downgrade. Three
medium leaks and a handful of low ones were confirmed in code:

- `services/orderAdvance.ts` let any purchaser advance any Draft to In Transit
  (deliberate in `d676bdeb`), while `GET /api/orders/:id` 403s a non-owner and
  the newer hand-off refuses one. The 409 blockers described an order the
  caller could not open.
- `inventory_events.detail` carries `sellOrder` (written by
  `routes/sellOrders.ts` on sold/unsold) and `transfer_order_id`, and `edited`
  events carry unit-cost before/after values; `/api/inventory/:id` and
  `/events/all|by-part` returned them unfiltered to the line's purchaser.
- `routes/facebookPool.ts` snapshot and `/summary` returned every account's
  full UID and email to any authed user while the purchaser picker masked them.
- Lows: a role change did not bump `credential_version`, so a demoted
  manager's OAuth access token kept manager scopes up to its TTL;
  `/oauth/authorize` redirected pre-consent errors to a self-registered
  client's URI with no session (open redirect); `/oauth/authorize/pending/:req`
  was not bound to the user; a purchaser's `POST /api/item-types` revived a
  retired type; the supplier duplicate 409 looked up by name across every book;
  `POST /api/suppliers/:id/notes` answered 403 (not 404) for another's client;
  `hidePending` told a purchaser which lots sell orders held; preference
  arrays were unbounded.

## Acceptance criteria

- [x] A purchaser's `POST /api/orders/:id/advance` on someone else's PO
      answers 404 (same body as a missing PO) and moves nothing; no PayPal
      pull runs for it. Owner and manager behaviour unchanged.
- [x] A purchaser's inventory event reads carry no `sellOrder` or
      `transfer_order_id`, and unit-cost edits carry no from/to; a manager's
      are unchanged.
- [x] `hidePending` is ignored for non-managers, and the toggle is hidden
      from them.
- [x] Pool snapshot and summary give a purchaser the UID cut to first+last
      four digits and the email to `ab•••@domain` on rows they don't hold; the
      cut `c_user` still matches the cut UID; held rows and managers are
      unchanged.
- [x] Demoting a manager bumps `credential_version` and revokes their OAuth
      refresh tokens and unredeemed codes; re-sending the same role does not.
- [x] `/oauth/authorize` with a self-registered client and no session answers
      pre-consent errors as JSON 400, not a redirect.
- [x] `/oauth/authorize/pending/:req` answers 404 to any user but the one who
      parked it.
- [x] A purchaser re-adding a retired item type gets 409 and it stays retired;
      a manager still revives it.
- [x] The duplicate-client 409 looks in the caller's target book; a note on
      someone else's client answers 404.
- [x] Preference arrays are capped at 100 entries of 64 characters.

## Out of scope

- Package tracking-number 409 ("already being tracked"): the number is one row
  per box, so the refusal is the information; a vaguer message says the same.
- Owner design questions left as they are: purchaser-set line sell prices
  feeding commission, the leaderboard ranking by commission, public R2
  attachment URLs, a host token still able to `/worker/claim`, `/metrics`
  without `PROXY_SECRET`, pool notes visible to every role (the picker shows
  them), the report overwriting a pool note (the page already folds the old
  note in).
- Defence-in-depth only: regex validation of coordinator/tracker proxy ids,
  payment-screenshot key shape, `scanImageId` ownership, inventory reads
  ignoring `rolePreview` (manager-only effect).

## Notes

- The draft-submit rule was the owner's call; with no answer given, it
  follows the hand-off: owners and managers only. A teammate who handles the
  goods can no longer submit on the owner's behalf; that use case had already
  stopped working in the UI because a non-owner cannot open the PO.
- The pool UID cut keeps digits only so `cookieHealth` on the page compares
  the cut UID with the cut `c_user` and needs no frontend change.
- Review reports: six markdown files from the Orca run `run_06ce2b64f87b`
  (session scratchpad, not kept in the repo).
