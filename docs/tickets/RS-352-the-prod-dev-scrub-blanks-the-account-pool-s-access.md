---
id: RS-352
title: The prod→dev scrub blanks the account pool's access tokens
type: bug
status: backlog
priority: P1
created: 2026-10-22
reporter: jinhu
branch: JinhuW/clam
pr:
version:
related: [RS-337]
---

## Ask

> fix this issue in the dev
> [Image #1]

## Context

The image was the ERP's error dialog on dev's Fleet page
(`inventory-dev.recycleservers.com/#/fleet`): *Something went wrong — Internal
error*, `GET /api/facebook-pool · 500 · d241c358-3627-40f3-a1d4-66ee7fd7473d`.

Dev's backend log for that request id shows the cause. `unseal()`
(`lib/sealed.ts`) threw `Unsupported state or unable to authenticate data`, an
AES-GCM authentication failure, inside `snapshot()` in
`routes/facebookPool.ts`. One blob that won't open fails the whole pool read.

The pool's logins are sealed under `FB_POOL_KEY`, and prod and dev have
different keys. The nightly prod→dev copy runs `deploy/railway-sync/scrub.sql`,
which blanks `password_enc`, `totp_enc`, `email_password_enc` and `cookie_enc`
for exactly this reason. `token_enc` was added afterwards, in migration 0190
(RS-337, v1.307.0), and never added to the scrub. Dev held 27 pool rows. All 27
had the four scrubbed columns empty, but rows #18–#27 (batch
`Order 2749318`, the first import that carried tokens) still had `token_enc`
sealed under prod's key.

That was also a leak. Every night, prod's live Facebook Graph access tokens
went into a database that everyone with dev access can read, and the scrub
exists to prevent exactly that.

## Acceptance criteria

- [x] `scrub.sql` blanks `token_enc` along with the other four sealed columns.
- [x] `tests/sync-scrub.test.ts` reads the pool's `*_enc` columns from
      `information_schema`, seeds each one and asserts each is NULL after the
      scrub. It fails against the old scrub on `token_enc` and passes against
      the new one.
- [x] The ten prod-sealed tokens already on dev are blanked, and every sealed
      column of every dev row opens under dev's `FB_POOL_KEY`.
- [ ] db-sync, which builds `deploy/railway-sync` from `dev`, runs the new
      scrub from the next 04:00 UTC copy.

## Out of scope

- Making `snapshot()` skip a blob it can't open instead of failing. On prod
  that would show managers blank logins they might then save over, and hide a
  real key problem. Failing loudly is right there. The bug was in what reached
  dev.
- Rotating `FB_POOL_KEY` after the Railway disclosure. That needs a re-seal
  script and is tracked separately.

## Notes

The dev rows were blanked with the same `UPDATE` the scrub runs, guarded on
`env_marker = 'dev'`. The next nightly copy would overwrite them anyway.
