-- Atomic human-id counters. The old `SELECT MAX(id)+1` then `INSERT` pattern
-- (orders SO-, sell_orders SL-, transfer_orders TO-) is a race: two concurrent
-- creates read the same max and the second collides on the primary key (500,
-- lost submission). Each create now runs
--   UPDATE id_counters SET value = value + 1 WHERE name = $1 RETURNING value
-- which takes a row lock, so allocations are serialized.
--
-- Idempotent: the runner re-applies every migration on each run, so the seed
-- uses ON CONFLICT DO NOTHING — the counter is initialised once (from the
-- current max for already-populated databases) and thereafter only ever moves
-- forward via the runtime UPDATE.

CREATE TABLE IF NOT EXISTS id_counters (
  name  TEXT PRIMARY KEY,
  value BIGINT NOT NULL
);

INSERT INTO id_counters (name, value)
VALUES ('SO', GREATEST(
  1288,
  (SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 4) AS INTEGER)), 1288)
     FROM orders WHERE id ~ '^SO-[0-9]+$')))
ON CONFLICT (name) DO NOTHING;

INSERT INTO id_counters (name, value)
VALUES ('SL', GREATEST(
  4000,
  (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\D', '', 'g'), '')::int), 4000)
     FROM sell_orders)))
ON CONFLICT (name) DO NOTHING;

INSERT INTO id_counters (name, value)
VALUES ('TO', GREATEST(
  1000,
  (SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 4) AS INTEGER)), 1000)
     FROM transfer_orders WHERE id ~ '^TO-[0-9]+$')))
ON CONFLICT (name) DO NOTHING;
