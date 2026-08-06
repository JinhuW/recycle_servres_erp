-- Photos attached to an individual purchase-order line.
--
-- A line photo already existed, but only as a side effect of an AI label scan
-- (order_lines.scan_image_id joins to label_scans for its delivery_url), so
-- only RAM lines could ever have one and only by going through OCR. A drive or
-- a spare part had no way to carry a picture at all.
--
-- Its own table rather than columns on order_lines: order_lines is also the
-- inventory table and already carries 25+ columns, and a photo needs five of
-- its own (key, url, mime, size, filename). Shape cloned from
-- order_status_attachments (0068), which is the working attachment schema —
-- the `attachments` table from 0014 is an orphan stub that never reached R2.
--
-- scan_image_id is deliberately left alone: it is the join key to label_scans,
-- which carries the extraction and confidence the drawer's AI banner reads.
-- The API merges the two into one `photos` array for the client.

CREATE TABLE IF NOT EXISTS order_line_photos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id UUID NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  -- Denormalized so both the ownership check and the R2 sweep on order delete
  -- are single-table lookups rather than a join back through order_lines.
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  mime_type     TEXT NOT NULL,
  storage_key   TEXT NOT NULL,         -- R2 object key, or 'stub:<uuid>' in dev
  delivery_url  TEXT NOT NULL,         -- public URL the frontend renders
  position      INTEGER NOT NULL DEFAULT 0,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS order_line_photos_line_idx
  ON order_line_photos(order_line_id, position, uploaded_at);
CREATE INDEX IF NOT EXISTS order_line_photos_order_idx
  ON order_line_photos(order_id);
CREATE INDEX IF NOT EXISTS order_line_photos_uploaded_by_idx
  ON order_line_photos(uploaded_by);
