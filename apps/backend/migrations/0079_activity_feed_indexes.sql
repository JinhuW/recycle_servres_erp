-- Indexes for the global Activity feed (GET /api/activity), which unions the
-- four audit ledgers and orders the result by created_at DESC.
--
-- Every existing index on these tables leads with the parent id
-- (order_events_order_idx is (order_id, created_at DESC), and the other three
-- follow the same shape) because until now every read was scoped to one
-- record. The feed has no parent predicate, so none of them are usable and
-- all four branches would seq-scan. These are the matching feed indexes.
--
-- `id` is the keyset tiebreaker (see lib/pagination.ts). Both columns are DESC
-- so they match the feed ORDER BY exactly — a plain (…, id) index leaves an
-- Incremental Sort on top of every branch.
--
-- No table changes here — the feed is a read-only view over ledgers that are
-- append-only by trigger (0037, 0038, 0050).

CREATE INDEX IF NOT EXISTS order_events_feed_idx
  ON order_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS sell_order_events_feed_idx
  ON sell_order_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS inventory_events_feed_idx
  ON inventory_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ref_price_events_feed_idx
  ON ref_price_events (created_at DESC, id DESC);
