# A5 repros

- `sync-scrub-fleet-proxies.test.ts` — A5-01. Copy into `apps/backend/tests/`,
  run `TEST_DATABASE_URL=... npx vitest run tests/sync-scrub-fleet-proxies.test.ts`
  from `apps/backend`, delete the copy. Passing = bug present.
  Plain-SQL equivalent used during the review (fresh PG18, all 218 migrations):
  `BEGIN; SELECT set_config('search_path','',true); INSERT INTO public.fleet_proxies(label,url_enc,host,port,timezone) VALUES ('p','v1.a.b.c','h',1,'UTC'); \i deploy/railway-sync/scrub.sql`
  → `ERROR: null value in column "url_enc" of relation "fleet_proxies" violates not-null constraint`.
- A5-04 (seed re-run) was reproduced by hand: migrate, `node scripts/seed.mjs`,
  insert one `bank_accounts` row and one `bank_transactions` row linked to a seeded
  sell order (`sell_order_id`, `link_kind='payment'`, `linked_at=now()`), run seed again
  → `violates check constraint "bank_transactions_link_kind_pair"`, exit 1, after
  `inventory_events` and `sell_order_lines` were already deleted in committed statements.
