---
id: RS-420
title: Fix what the dev-to-prod review found before the v1.367 release
type: bug
status: done
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/sauger
pr: 941
version: 1.367.2
related: [RS-394, RS-396, RS-399, RS-402, RS-405]
---

## Ask

> /code-review high dev to main. fix all issue and release to prod.

## Context

The review of everything on `dev` not yet on `main` (90 commits, through
v1.367.1) reported ten findings. Nine are fixed here; one is kept as designed.

## Acceptance criteria

- [x] The nightly prod→dev copy brings back each slotted pool account's
      holder (`holder_name`, `held_since`, `holder_user_id`), so dev workers
      keep passing `eligibleSlot` instead of exiting on `stale_epoch` and
      logging in again.
- [x] `poll_hold_seconds` tops out at 90, under Cloudflare's 100 s origin cut.
- [x] A release waits for an authoritative host that has been silent only a
      few minutes, and skips it only after the gate timeout (20 min).
- [x] A RAM bid row keeps its place from its first line, zeros included, and
      lists only the part numbers of lines above 0.
- [x] The claim checks worker ids with the same rule as the rest of the host
      protocol (`hosts.ts` `ownWorkerId`).
- [x] The purchaser's Home **Done** tile counts every Done PO, as the list it
      opens shows, and says "all time".
- [x] A heartbeat's `vnc_port` outside 1–65535 and a `last_search_at` over 64
      characters are dropped.
- [x] The budget check and the slot list read today's minutes from the
      attempts that can reach today, not the whole `fleet_minutes` view.
- [x] No comment cites a ticket number in `fleet/hosts.ts`.

## Out of scope

- **`onlyUnlinked` on `PATCH /api/accounting/entries/:id`.** The review read it
  as a client flag that gets around the company-paid refusal. It is the PO
  page's explicit "link this RMB payment" action. A test
  (`payment-form-sources.test.ts`, "replaces a legacy company payer flag")
  asserts that it replaces the flag, and a manager can set the payer directly
  through `PUT /api/orders/:id/commission-paid-by` anyway. A bank row linked as
  the commission still refuses it.
