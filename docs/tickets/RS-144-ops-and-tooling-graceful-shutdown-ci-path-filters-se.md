---
id: RS-144
title: "Ops and tooling: graceful shutdown, CI path filters, session-launcher races, destructive-script guard, prod-to-dev scrub"
type: task
status: done
priority: P2
created: 2026-10-02
reporter: jinhu
branch: fix/ops-tooling
pr: "#463"
version: 1.196.1
related: [RS-130, RS-134, RS-143]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

This is Batch 4 of the approved plan,
`docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`, covering
review findings M31, M32, M33, M8 and M7. The decision recorded with the plan
for the prod→dev copy was "Secrets, keep logins": scrub credentials and keep
password hashes.

## Context

- **M31: every redeploy ended in SIGKILL.** The container CMD was
  `sh -c "… && pnpm start"`. The shell held PID 1 and forwarded no signal, and
  nothing installed a SIGTERM handler, so in-flight requests died at the
  draining deadline. Railway shows no dashboard start command on the prod or
  dev backend (checked read-only, 2026-10-02), so the Dockerfile CMD is what
  runs. The draining window is still Railway's default on both.
- **M32: CI ignored root manifests.** `backend-tests` and `deploy-frontend`
  filtered on `apps/`, `packages/` and their own workflow file. A lockfile,
  workspace or `.nvmrc` change ran no tests and shipped nothing, and
  `version-check` didn't count them, or `backup/` and `infra/`, as code.
- **M33: two launchers could take one slot.** Choosing an idle slot and
  writing its claim were separate steps, with the claim written last. The
  `--print-only` claim expired after 8h, which is how a running session's
  worktree was swept. Only the lock decided liveness, so a resumed session or
  a leftover `pnpm dev` didn't count.
- **M8: destructive scripts trusted `DATABASE_URL`.** `seed.mjs` deletes every
  order and `migrate.mjs --reset` drops every table. Only `--reset` had a
  guard, and only on `NODE_ENV=production`.
- **M7: the nightly prod→dev copy carried live credentials.** Refresh tokens,
  OAuth grants and client secrets copied to dev would still work against
  prod's own backend.

## Acceptance criteria

- [x] SIGTERM makes the backend stop its loops, finish in-flight requests
      (cutting connections after 20s), close the pool and exit 0 within 25s.
- [x] `backend-tests` and `deploy-frontend` run on changes to `pnpm-lock.yaml`,
      `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`
      and `.nvmrc`. `version-check` counts those files, plus `backup/` and
      `infra/`, as code.
- [x] Two launchers started together never get the same slot. A slot is
      claimed as soon as it's chosen. `--print-only` claims with the calling
      session's claude PID. A slot with any process inside it is live, and
      the `SessionStart` hook records the session's PID for a slot it starts
      in.
- [x] `seed.mjs` and `migrate.mjs --reset` exit 1 before connecting to a
      non-local host unless the named override is set.
- [x] The sync clears refresh tokens, OAuth codes, OAuth refresh tokens,
      pending consents, login attempts and OAuth client secrets inside the
      restore transaction, and keeps password hashes. A test runs the scrub
      against the migrated schema.

## Out of scope

These ops steps each need the user's go-ahead:
- Setting Railway's draining window to about 30s on prod and dev.
- Creating a read-only `prod_reader` role and pointing the sync's
  `PROD_DATABASE_URL` at it.

## Notes

- The shutdown helper cuts connections because `server.close()` waits for
  every open socket, and an MCP session never ends on its own.
- The launcher's mutex is a `mkdir` under `.locks/.select` that stores its PID,
  so a crashed launcher's mutex is taken over instead of blocking everyone.
- Verified in a scratch repo: two concurrent `--print-only` runs against idle
  slots got different slots, a foreground run recorded the claude PID, and
  `--prune` kept a slot with a live process inside even though its lock was
  dead.
