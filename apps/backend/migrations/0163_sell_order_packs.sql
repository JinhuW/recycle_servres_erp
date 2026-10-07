-- Pack mode: a manager ticks a sell order's lines into the box.
-- One row per line that has been touched; a line with no row reads as its
-- full qty, unpacked.
--
-- Keyed on the line's identity, not sell_order_lines.id: saving the order's
-- lines deletes and re-inserts every row, which would wipe the progress. The
-- key is the lot (inventory_id), or a hash of a hand-typed line's text, plus
-- an occurrence number for the same identity appearing twice
-- (routes/sellOrderPack.ts builds it). line_qty is the qty the row was
-- written against, so a qty edit is detected rather than silently trusted.
CREATE TABLE sell_order_packs (
  sell_order_id TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  line_key      TEXT NOT NULL,
  line_qty      INTEGER NOT NULL CHECK (line_qty > 0),
  counted       INTEGER NOT NULL CHECK (counted >= 0 AND counted <= line_qty),
  -- When the line was ticked; orders the Packed group. Never derived from counted.
  packed_at     TIMESTAMPTZ,
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sell_order_id, line_key)
);
CREATE INDEX sell_order_packs_updated_by_idx ON sell_order_packs(updated_by);
