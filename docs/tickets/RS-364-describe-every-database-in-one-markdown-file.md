---
id: RS-364
title: Describe every database in one Markdown file
type: task
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: docs/database-reference
pr:
version: n/a — docs only, no release
related: [RS-255]
---

## Ask

> Pls create an DB markdown file to describe all DB about my system.

## Context

The system runs three databases. They share no data and no migration ledger,
and no document covers them as a whole:

- **ERP:** Postgres 18 on Railway `recycle-erp-experiment`. Its schema is
  whatever `apps/backend/migrations/0001…0203` add up to once
  `scripts/migrate.mjs` has applied them. About 67 tables are live, and 9 more
  were dropped along the way.
- **Reddit tracker:** Postgres on Railway `reddits-tracker`. The schema is
  `trackers/reddit/migrations/0001…0004`, applied by `scripts/migrate.ts`.
- **Facebook coordinator:** Postgres on Railway `facebook-tracker` in prod, and
  SQLite locally and in tests. The schema is `SCHEMA` plus the
  `*_EXTRA_COLUMNS` lists in `rs_coordinator/db.py`; `pg.py` translates them
  for Postgres.

Learning any table today means replaying migrations by hand.

## Acceptance criteria

- [x] `docs/DATABASE.md` covers the ERP, Reddit tracker and Facebook coordinator databases.
- [x] Every live table has a short purpose line and a table of its columns (name, type, null, default, meaning), plus its keys and indexes.
- [x] Each ERP domain has a Mermaid ER diagram for its foreign keys.
- [x] For each DB, the doc says where it runs, which env var points at it, how migrations apply, and how it is backed up or synced.
- [x] The doc records which migration or version it was generated from.
- [x] Root `AGENTS.md` *Pointers* links to the doc, and each area's schema rules say that a schema change updates its section.

## Out of scope

- A checked-in generator, or a CI check that diffs the doc against the migrations.
- The vendored `ai-marketplace-monitor` caches.
- Any schema change. The bug and the dead columns below were recorded, not fixed.

## Notes

- **How the structure was produced.** Each database was built from scratch in
  a throwaway Postgres 18 by its own runner: `migrate.mjs` (201 files),
  `migrate.ts` (4), and the coordinator's `PostgresDatabase` boot. The catalog
  was then read back. The result is 112 tables and 1,184 columns. Meanings
  were drafted from migration comments and the code that uses each column, and
  every table and column name was checked against the catalog.
- **Likely bug, not fixed here.** `lib/marketWrite.ts` sets
  `ref_prices.trend = NULL` when the row's previous `avg_sell` is NULL, and
  `trend` is `NOT NULL`. Auto-tracked rows (`lib/marketAutoTrack.ts`) are
  inserted with no `avg_sell`, so the scraper's first write to one should fail
  and roll back its batch.
- **Dead or unread data.**
  - Nothing in `apps/` reads or writes `shipments` since the label flow was
    removed.
  - Nothing reads `categories.requires_pn`, `categories.default_margin` or
    `po_ai_reviews.lines_hash`.
  - The Settings → General keys (including `notify_*`) are stored but never
    read.
  - On the Facebook side, `threads.topic_state` and `sightings` are unused.
- **Schema irregularities the doc states rather than hides.**
  - 15 FKs have no `ON DELETE` clause.
  - 14 FKs have no leading index.
  - `sell_order_events` refuses even a cascaded delete.
  - `after_sales_case_events` has no append-only trigger.
  - The Facebook `accounts.proxy` column is plaintext.
