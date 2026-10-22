-- Reopening a Done sell order withdraws its market data points by source
-- (`sale:<id>`), inside a transaction that holds the order's source POs, its
-- header and its lots. Without this index that DELETE scans every event, and
-- bulk price-list imports keep the table growing.
CREATE INDEX IF NOT EXISTS ref_price_events_source_idx
  ON ref_price_events (source);
