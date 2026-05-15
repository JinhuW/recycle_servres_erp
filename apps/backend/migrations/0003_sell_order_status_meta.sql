-- Per-status evidence captured when a sell order advances through
-- Shipped → Awaiting payment → Done. The Draft status never appears here.
--
-- Mirrors the design's `statusMeta[s] = { note, attachments, when }` shape,
-- split into two tables so attachments can be added/removed independently
-- of the text note.

CREATE TABLE IF NOT EXISTS sell_order_status_meta (
  sell_order_id TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  status        TEXT NOT NULL
                  CHECK (status IN ('Shipped','Awaiting payment','Done')),
  note          TEXT,
  set_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  set_by        UUID REFERENCES users(id),
  PRIMARY KEY (sell_order_id, status)
);

CREATE TABLE IF NOT EXISTS sell_order_status_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sell_order_id TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  status        TEXT NOT NULL
                  CHECK (status IN ('Shipped','Awaiting payment','Done')),
  filename      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  mime_type     TEXT NOT NULL,
  storage_key   TEXT NOT NULL,         -- R2 object key, or 'stub:<uuid>' in dev
  delivery_url  TEXT NOT NULL,         -- public URL the frontend renders
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by   UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS sell_order_status_attachments_so_status_idx
  ON sell_order_status_attachments(sell_order_id, status);
