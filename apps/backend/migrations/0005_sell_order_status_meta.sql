CREATE TABLE IF NOT EXISTS sell_order_status_meta (
  sell_order_id   TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('Shipped','Awaiting payment','Done')),
  note            TEXT,
  attachment_ids  TEXT[] NOT NULL DEFAULT '{}',
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by     UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (sell_order_id, status)
);
