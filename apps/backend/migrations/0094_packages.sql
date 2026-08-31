-- Standalone tracked packages: labels bought outside the system ("add an
-- external label"). No PO at first — the draft PO is created when the box
-- arrives (POST /api/packages/:id/create-po). Status vocabulary is the
-- tracked subset of shipments.status so the dashboard rail serves both.

CREATE TABLE packages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_number TEXT NOT NULL,
  carrier         TEXT NOT NULL CHECK (carrier IN ('UPS','FedEx','USPS')),
  status          TEXT NOT NULL DEFAULT 'purchased'
                    CHECK (status IN ('purchased','in_transit','delivered','exception')),
  tracking_status TEXT,
  tracking_eta    TIMESTAMPTZ,
  last_tracked_at TIMESTAMPTZ,
  seller_name     TEXT,
  note            TEXT,
  -- SET NULL: deleting a PO returns the package to standalone rather than
  -- silently erasing its tracking history.
  order_id        TEXT REFERENCES orders(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per physical box: the same number pasted twice would create two
-- rows that both grow a PO on delivery.
CREATE UNIQUE INDEX packages_tracking_number_idx ON packages (tracking_number);
CREATE INDEX packages_order_id_idx   ON packages (order_id);
CREATE INDEX packages_created_by_idx ON packages (created_by);
CREATE INDEX packages_active_track_idx ON packages (status)
  WHERE status IN ('purchased','in_transit','exception');

-- The cross-PO shipments list pages on (created_at DESC, id).
CREATE INDEX shipments_created_at_idx ON shipments (created_at DESC);
