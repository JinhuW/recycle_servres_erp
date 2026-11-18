-- Posts can now arrive by webhook from the redditapis.com monitor instead of
-- the workers' own Reddit polling, which Reddit's RSS withdrawal broke
-- (docs/debug-notes/reddit-new-rss-404.md).
--
-- poll_source picks who discovers posts: 'reddit' keeps the poll loop on,
-- 'webhook' idles it so the fleet stops polling a dead feed.
INSERT INTO settings (key, value) VALUES
  ('poll_source', to_jsonb('reddit'::text))
ON CONFLICT (key) DO NOTHING;

-- One row per accepted delivery. delivery_id is the vendor's idempotency key
-- (deliveries are at-least-once), and received_at is what the ops watch reads
-- to notice the webhook going quiet.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  monitor_id  TEXT,
  items       INT NOT NULL,
  inserted    INT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_received_at
  ON webhook_deliveries (received_at);
