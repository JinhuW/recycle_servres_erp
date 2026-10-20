---
id: RS-337
title: Add an access-token field to the Facebook account pool
type: story
status: done
priority: P2
created: 2026-10-20
reporter: jinhu
branch: import-fb-account-pool
pr: 804
version: 1.307.0
related: []
---

## Ask

> Import the account infomrtaion to the prod db - faceboot account pool:
> /Users/jinhu/Projects/recycle_servers_v2/recycle_servres_erp-lancetfish/.orca/drops/order_2749318_parsed_2026-10-20.csv

When asked where the supplier CSV's `令牌` (access-token) column should go, since
the pool had no field for it: **"add a new field called token"**. And asked how
the import should reach prod: **"I write to the prod DB directly"**.

## Context

A purchased batch of 10 Facebook accounts (supplier CSV
`.orca/drops/order_2749318_parsed_2026-10-20.csv`) goes into the ERP's Facebook
account pool (`fb_pool_accounts`, `routes/facebookPool.ts`). The CSV carries a
`令牌` column — the Facebook Graph access token (`EAA…`) — which has no field in
the pool today. The pool's fields are uid / password / totp / email /
email-password / recovery / cookie / note; `note` is stored as plaintext and
shown in the UI, so an access token could not safely live there. Secrets
(password, totp, email-password, cookie) are sealed with AES-GCM under
`FB_POOL_KEY` (`lib/sealed.ts`); the token is one more such secret.

## Acceptance criteria

- [ ] Migration adds `token_enc` to `fb_pool_accounts` (sealed; NULL when absent).
- [ ] A manager can set and edit `token` in the account editor, and it persists.
- [ ] `token` is revealed only to a manager or the holding purchaser; everyone
      else reads it as `''` in the pool snapshot.
- [ ] A copy or reveal of `token` writes an audit event (it is in `FB_POOL_SECRET_FIELDS`).
- [ ] The paste importer accepts a token column (after cookie, before notes).
- [ ] `pnpm typecheck`, backend and frontend suites green.

## Out of scope

- Passing the token to the fleet vault on `/assign` — the coordinator vault has
  no token field; the token stays pool-side only.
- Any automated CSV-upload UI or change to the supplier CSV format.

## Notes

- Plan: `~/.claude/plans/snug-sauteeing-shore.md`.
- The order-2749318 import itself is a one-off direct prod DB write done after
  this ships (a throwaway script that reuses `lib/sealed.ts` `seal()`), not part
  of the shipped code.
