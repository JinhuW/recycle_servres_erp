-- Optional evidence (note + attachments) captured when a manager moves a
-- purchase order to Done. Mirrors the sell-order split schema (0003): the
-- text note upserts independently of the attachment rows. The CHECK starts
-- at 'Done' only — widening to earlier stages is a DB-only change.

CREATE TABLE IF NOT EXISTS order_status_meta (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status   TEXT NOT NULL CHECK (status IN ('Done')),
  note     TEXT,
  set_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  set_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (order_id, status)
);
CREATE INDEX IF NOT EXISTS order_status_meta_set_by_idx
  ON order_status_meta(set_by);

CREATE TABLE IF NOT EXISTS order_status_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('Done')),
  filename     TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  mime_type    TEXT NOT NULL,
  storage_key  TEXT NOT NULL,         -- R2 object key, or 'stub:<uuid>' in dev
  delivery_url TEXT NOT NULL,         -- public URL the frontend renders
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by  UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS order_status_attachments_order_status_idx
  ON order_status_attachments(order_id, status);
CREATE INDEX IF NOT EXISTS order_status_attachments_uploaded_by_idx
  ON order_status_attachments(uploaded_by);
