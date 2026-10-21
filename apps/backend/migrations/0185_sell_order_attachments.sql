-- Files that belong to a sell order as a whole — the marketplace sale
-- record, the invoice sent, a packing list — as opposed to the per-status
-- evidence in sell_order_status_attachments (mig 0003), whose `status`
-- column is checked against real statuses and whose rows are tied to a
-- transition. Same storage shape so r2.ts and the chip renderer need no
-- second code path.

CREATE TABLE IF NOT EXISTS sell_order_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sell_order_id TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  mime_type     TEXT NOT NULL,
  storage_key   TEXT NOT NULL,         -- R2 object key, or 'stub:<uuid>' in dev
  delivery_url  TEXT NOT NULL,         -- public URL the frontend renders
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS sell_order_attachments_so_idx
  ON sell_order_attachments(sell_order_id, uploaded_at);
CREATE INDEX IF NOT EXISTS sell_order_attachments_uploaded_by_idx
  ON sell_order_attachments(uploaded_by);
