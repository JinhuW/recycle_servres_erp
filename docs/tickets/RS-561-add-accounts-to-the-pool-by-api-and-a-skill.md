---
id: RS-561
title: Add accounts to the pool by API and a skill
type: story
status: done
priority: P2
created: 2026-11-06
reporter: jinhu
branch: JinhuW/gramma
pr: 1136
version: 1.434.0
related: []
---

## Ask

> create an skills for adding account to the account pools and create an api endpoint for adding accounts.

> The skill should be noted in the Aent.md

## Context

Accounts reach the Facebook pool through the manager page (`POST /api/facebook-pool`
and `/import` in `routes/facebookPool.ts`, which need a manager cookie and a CSRF
header and answer with the whole pool's unsealed secrets), or through an
out-of-band script writing to the prod DB with Railway credentials and `seal()`.
Neither suits an agent. A narrow service-client route, on the `wechat:write` /
`fleet:read` pattern, can add accounts and read none back.

Adding a row causes no Facebook login: workers claim from `fleet_slots`, and a
slot only comes from `/assign`.

## Acceptance criteria

- [x] `POST /api/facebook-pool/push/accounts` with a `pool:write` service token adds the rows as `available` and answers 201 with `{ batch, added: [{ no, uid }] }`, with no secrets.
- [x] The batch is all-or-nothing. A bad or duplicate row writes nothing and answers 400/409 naming each row's index, uid and codes.
- [x] These are refused: no token (401), a token without the scope (403), a user-consented token (403), and a manager cookie alone (401).
- [x] `pool:write` is never handed out by self-registration, and a manager can tick it under Settings → Connectors.
- [x] The audit log shows the service client's name as the actor. `created_by` is NULL.
- [x] The skill previews rows with secrets masked, gets a yes, then adds them. It never prints a secret.
- [x] The skill is noted in `AGENTS.md`.

## Out of scope

Assigning to workers, editing or reading accounts over the API, an MCP tool,
partial-success imports, and server-side parsing of raw pasted text.

## Notes

The skill is `.claude/skills/fb-pool-add/`. It reads its service client from
`~/.config/recycle-erp/pool-client.env`, outside the repo.
