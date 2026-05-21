-- Per-PO audit log. Starts the moment a draft is submitted for review
-- (Draft → In Transit) and captures every subsequent change to the order:
-- lifecycle advances, line edits, line add/remove, and order-level meta.
-- Sibling to inventory_events (per-line) but scoped to the parent PO so the
-- timeline survives line deletions and can render order-only events.
--
-- Append-only via BEFORE UPDATE/DELETE triggers — same pattern as 0012.

CREATE TABLE IF NOT EXISTS order_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id),
  kind        TEXT NOT NULL, -- submitted | advanced | line_added | line_removed | line_edited | meta_changed
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events(order_id, created_at DESC);

CREATE OR REPLACE FUNCTION order_events_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_events_no_update ON order_events;
DROP TRIGGER IF EXISTS order_events_no_delete ON order_events;
CREATE TRIGGER order_events_no_update BEFORE UPDATE ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_lock();
-- Note: BEFORE DELETE fires even on CASCADE. Orders can only be deleted while
-- in 'draft' lifecycle (see DELETE /api/orders/:id guard), and drafts have no
-- audit events by design, so the cascade never has rows to delete.
CREATE TRIGGER order_events_no_delete BEFORE DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_lock();
