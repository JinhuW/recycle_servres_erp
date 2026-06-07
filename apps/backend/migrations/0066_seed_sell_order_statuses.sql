-- Backfill sell_order_statuses, which only existed in seed.mjs and never landed
-- in a migration (same gap 0060 fixed for catalog_options). Prod deploys don't
-- run db:seed, so the table is empty there: GET /api/lookups returns
-- sellOrderStatuses: [], and the sell-order detail's status stepper renders zero
-- steps — the order's status shows (the chip falls back to the 'muted' tone) but
-- there is no way to advance it. Manager-only surface, so it looked like a
-- permissions bug; the real cause is missing reference data.
--
-- Mirrors apps/backend/scripts/seed.mjs (label = id; positions set the stepper
-- order; needs_meta drives the evidence dialog on Shipped/Awaiting/Done/Closed).
-- Idempotent via the id primary key so a freshly-seeded dev DB is unaffected.
INSERT INTO sell_order_statuses (id, label, short_label, tone, needs_meta, position) VALUES
  ('Draft',            'Draft',            'Draft',        'muted', FALSE, 0),
  ('Shipped',          'Shipped',          'Shipped',      'info',  TRUE,  1),
  ('Awaiting payment', 'Awaiting payment', 'Awaiting pay', 'warn',  TRUE,  2),
  ('Done',             'Done',             'Done',         'pos',   TRUE,  3),
  ('Closed',           'Closed',           'Closed',       'muted', TRUE,  4)
ON CONFLICT (id) DO NOTHING;
