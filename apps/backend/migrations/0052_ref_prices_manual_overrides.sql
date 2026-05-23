-- Denormalised "last recorded price" for the Market Value surface.
-- The page used to read avg_sell as the headline metric, but with few
-- samples per SKU an average is a poor reference; last_price is the
-- price someone actually saw most recently, and last_price_at drives a
-- 5-day staleness signal in the UI.
--
-- Both columns are populated by the appendPriceEvent helper, which is
-- the single write path for manual entries, scraper batches, and seed.
-- avg_sell stays in place (MCP + legacy callers still read it).

ALTER TABLE ref_prices
  ADD COLUMN IF NOT EXISTS last_price        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS last_price_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_price_source TEXT;

CREATE INDEX IF NOT EXISTS ref_prices_last_price_at_idx
  ON ref_prices (last_price_at DESC);

-- Per-entry audit trail. Parallel to sell_order_events / order_events:
-- append-only, indexed for the "last 12 events" sparkline read path.
-- actor_user_id NULLs out on user delete so the event survives — the
-- price/source/timestamp are the load-bearing fields.

CREATE TABLE IF NOT EXISTS ref_price_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_price_id  TEXT NOT NULL REFERENCES ref_prices(id) ON DELETE CASCADE,
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  source        TEXT    NOT NULL,
  note          TEXT,
  actor_user_id UUID    REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ref_price_events_ref_price_id_idx
  ON ref_price_events (ref_price_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ref_price_events_actor_user_id_idx
  ON ref_price_events (actor_user_id);
