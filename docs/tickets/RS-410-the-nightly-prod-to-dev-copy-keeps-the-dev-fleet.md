---
id: RS-410
title: The nightly prod-to-dev copy keeps the dev fleet
type: task
status: backlog
priority: P1
created: 2026-10-26
reporter: jinhu
branch: fleet/dbsync-keep-dev-fleet
pr:
version:
related: [RS-394]
---

## Ask

> 1. Sync change: make deploy/railway-sync keep, on dev, every fleet_* table's rows and the sealed *_enc columns, cookie_uid, cookie_at, status and note of fb_pool_accounts rows that have a fleet_slots row on dev (snapshot on dev before the restore, restore after the migrations, one transaction where possible; never write to prod).

## Context

The nightly db-sync (`0 4 * * *` UTC) replaces dev with a scrubbed prod copy.
On 2026-10-26 04:03 UTC it emptied every `fleet_*` table, nulled every pool
`*_enc` and dropped host `worker-60-14`, so the dev fleet's agent got 401 and
every slot was gone. Dev now runs real fleet workers on live Facebook
accounts (the RS-394 pilot); losing their slots each night costs a login per
worker. Prod has no fleet tables yet (main stops at migration 0205), so the
tables exist on dev again only after the redeployed backend migrates.

## Acceptance criteria

- [x] Before the drop, in the restore transaction, every `fleet_*` table and
      the slotted pool rows are copied into a `sync_keep` schema.
- [x] After the backend redeploy, the job waits until every migration dev had
      is applied again, then restores in one transaction: the pool columns
      (only onto the same `uid`), every fleet row, id sequences past the kept
      ids, and drops `sync_keep`.
- [x] A slot whose pool number now holds another account is not restored.
- [x] A run whose restore did not finish leaves `sync_keep`, and the next run
      refuses rather than replacing it with an empty fleet.
- [x] Nothing is written to prod.

## Out of scope

Keeping any other dev-only data; the fleet tables' contents on prod once the
fleet ships there (dev's fleet replaces them on dev).

## Notes

Dry run against a private PostgreSQL 18 container holding two clones of dev
(one shaped like prod: no fleet tables, migrations to 0205), with the sync
image built from this tree and a stub `curl`: the full run restored 3 slots'
worth of fixtures minus one uid-changed account after a 30 s wait; the
leftover guard refused a second run; a 20 s timeout exited 1 and kept
`sync_keep`; `restore-fleet.sql` by hand recovered it. Test:
`apps/backend/tests/sync-keep-fleet.test.ts`.
