---
id: RS-519
title: Prod-to-dev sync survives a NOT NULL sealed column
type: bug
status: done
priority: P2
created: 2026-11-03
reporter: jinhu
branch: JinhuW/silverside
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1077
version: 1.414.3
related: []
---

## Ask

> yes.

Answering: "Do you want me to fix `db-sync`?"

## Context

`db-sync`, the nightly prod-to-dev copy (04:00 UTC), crashed in its scrub step:
`null value in column "url_enc" of relation "fleet_proxies" violates not-null
constraint`. `deploy/railway-sync/scrub.sql` set every `*_enc` column to NULL, but
migration 0213 made `fleet_proxies.url_enc` NOT NULL. Once prod's copy held proxy
rows, the whole restore rolled back.

Production wasn't affected. Dev stayed up but stale: on 2026-11-04 its newest order
was from 2026-10-27, so it had probably missed about a week of syncs.
`sync-scrub.test.ts` never inserted a `fleet_proxies` row, so CI didn't see it.

## Acceptance criteria

- [x] The scrub succeeds with `fleet_proxies` rows present.
- [x] Afterwards `url_enc` is `''`, and label, host, port and timezone are kept.
- [x] Nullable `*_enc` columns still become NULL.
- [x] A NOT NULL `*_enc` column on a table the scrub has never heard of is blanked too.

## Out of scope

- Changing prod's schema to allow NULL.
- Making sync failures alert louder.
- Running a sync by hand.

## Notes

The empty string is safe because dev runs `FLEET_ROLE=mirror`: the proxy health loop
is off, `mirrorGate` refuses writes and probes, and the proxy list never selects the
column. On an ERP that isn't a mirror, `unseal('')` would throw.

The green `db-sync` marks on commits only mean the deployment worked. The sync
itself runs from the cron, so those marks say nothing about whether it succeeded.

The real proof is the next cron run after this reaches `dev`. A sync wasn't started
by hand because it replaces the whole dev database.
