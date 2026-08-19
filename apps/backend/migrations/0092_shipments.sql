-- Prepaid shipping labels bought for sellers on a purchase order, one row per
-- box. Addresses are snapshots (the warehouse row can change after a label is
-- printed), rate/carrier fields are provider-returned values recorded at buy
-- time, never client input.
--
-- label_cost + fees_applied pair with orders.other_fees: buying a label adds
-- label_cost to the PO's other_fees, voiding subtracts it back. fees_applied
-- is the idempotency latch so a retried void can't subtract twice.
--
-- seller_token is reserved for the planned seller self-service link (vendor
-- portal style); no endpoint reads it yet.
--
-- ON DELETE CASCADE on order_id is deliberate: the orders DELETE route refuses
-- to delete a PO that has a purchased/in_transit/delivered shipment, so the
-- cascade only ever sweeps draft, quoted, or voided rows.

CREATE TABLE shipments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','quoted','purchased','in_transit',
                                    'delivered','voided','exception')),
  -- ship-from (seller), entered by the purchaser
  from_name     TEXT NOT NULL,
  from_phone    TEXT,
  from_street1  TEXT NOT NULL,
  from_street2  TEXT,
  from_city     TEXT NOT NULL,
  from_state    TEXT NOT NULL,
  from_zip      TEXT NOT NULL,
  from_country  TEXT NOT NULL DEFAULT 'US',
  -- ship-to snapshot (the PO's warehouse at buy time; no FK)
  to_name       TEXT,
  to_phone      TEXT,
  to_street1    TEXT,
  to_street2    TEXT,
  to_city       TEXT,
  to_state      TEXT,
  to_zip        TEXT,
  to_country    TEXT,
  -- package
  weight_oz     NUMERIC(8,2) NOT NULL CHECK (weight_oz > 0),
  length_in     NUMERIC(6,2) NOT NULL CHECK (length_in > 0),
  width_in      NUMERIC(6,2) NOT NULL CHECK (width_in  > 0),
  height_in     NUMERIC(6,2) NOT NULL CHECK (height_in > 0),
  -- purchase snapshot
  carrier              TEXT,
  service              TEXT,
  rate_amount          NUMERIC(10,2),
  rate_currency        TEXT NOT NULL DEFAULT 'USD',
  delivery_days        INT,
  provider             TEXT NOT NULL CHECK (provider IN ('shipsaving','stub')),
  provider_rate_id     TEXT,
  provider_shipment_id TEXT,
  tracking_number      TEXT,
  tracking_url         TEXT,
  label_storage_key    TEXT,
  label_delivery_url   TEXT,
  label_cost           NUMERIC(10,2),
  fees_applied         BOOLEAN NOT NULL DEFAULT FALSE,
  tracking_status      TEXT,
  tracking_eta         TIMESTAMPTZ,
  last_tracked_at      TIMESTAMPTZ,
  seller_token         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX shipments_order_id_idx   ON shipments(order_id);
CREATE INDEX shipments_created_by_idx ON shipments(created_by);
-- The tracking poll scans only live purchased shipments.
CREATE INDEX shipments_active_track_idx ON shipments(status)
  WHERE status IN ('purchased','in_transit','exception');
