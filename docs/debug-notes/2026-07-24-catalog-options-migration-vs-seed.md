# A `catalog_options` migration alone does not change dev or test

**Date:** 2026-07-24
**Symptom:** Wrote `0078_ssd_cap_1tb.sql` to add `1TB` and drop `1024GB` from
the SSD capacity dropdown. Migration was correct, ran clean, and the test
asserting `SSD_CAP` contains `1TB` still failed with the old list.

## Cause

`apps/backend/scripts/seed.mjs` owns the catalog in seeded environments. Near
the end of `main()` it does:

```js
await sql`DELETE FROM catalog_options`;
```

…then re-inserts every group from hardcoded arrays at the top of the file
(`SSD_CAP`, `RAM_CAP`, `HDD_CAP`, …). Seeding runs **after** migrations, so it
silently overwrites whatever a catalog migration just did.

The test harness makes this invisible: `resetDb()` clones a template DB that was
built migrate-then-seed, so the seed's list is what every test sees.

## Fix

Catalog option changes need **both**:

1. `apps/backend/migrations/NNNN_*.sql` — the only path that reaches production,
   which runs migrations and never seeds.
2. The matching array in `apps/backend/scripts/seed.mjs` — what dev, test, and
   `pnpm db:reset` actually end up with.

Change one without the other and prod and dev drift apart, in whichever
direction you forgot.

## Tripwire

If a `catalog_options` / lookup-table change "doesn't take" in tests or local
dev, check `seed.mjs` before debugging the migration. The migration is probably
fine.
