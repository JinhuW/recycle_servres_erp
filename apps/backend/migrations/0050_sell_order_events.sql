-- Per-SO audit log. Independent of the PO order_events table — sell orders
-- have their own lifecycle (Draft → Shipped → Awaiting payment → Done) and
-- their own actors / commission story, so the audit timelines stay parallel
-- but unjoined.
--
-- This change only emits `archived` / `unarchived` events; other event
-- kinds (status_changed, line_added, meta_changed, etc.) are reserved for
-- a follow-up that wires the rest of routes/sellOrders.ts up to the table.
--
-- Append-only via BEFORE UPDATE/DELETE triggers — same pattern as 0037.

CREATE TABLE IF NOT EXISTS sell_order_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sell_order_id TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  actor_id      UUID REFERENCES users(id),
  kind          TEXT NOT NULL, -- archived | unarchived | (future kinds)
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sell_order_events_order_idx
  ON sell_order_events(sell_order_id, created_at DESC);

CREATE OR REPLACE FUNCTION sell_order_events_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sell_order_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sell_order_events_no_update ON sell_order_events;
DROP TRIGGER IF EXISTS sell_order_events_no_delete ON sell_order_events;
CREATE TRIGGER sell_order_events_no_update BEFORE UPDATE ON sell_order_events
  FOR EACH ROW EXECUTE FUNCTION sell_order_events_lock();
-- Note: BEFORE DELETE fires even on CASCADE. Sell orders are never
-- deleted (the route layer exposes archive only, never DELETE), so the
-- cascade path here is theoretical — but the trigger still guarantees
-- the append-only invariant if a future change ever touches the parent.
CREATE TRIGGER sell_order_events_no_delete BEFORE DELETE ON sell_order_events
  FOR EACH ROW EXECUTE FUNCTION sell_order_events_lock();
