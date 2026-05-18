-- Vendor bidding link: public catalog + offers.

CREATE TABLE IF NOT EXISTS vendor_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  label         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at    TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS vendor_links_customer_idx ON vendor_links(customer_id);

CREATE TABLE IF NOT EXISTS vendor_bids (
  id             TEXT PRIMARY KEY,
  vendor_link_id UUID NOT NULL REFERENCES vendor_links(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES customers(id),
  contact_name   TEXT NOT NULL,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','partly_decided','decided')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS vendor_bids_link_idx   ON vendor_bids(vendor_link_id);
CREATE INDEX IF NOT EXISTS vendor_bids_status_idx ON vendor_bids(status);

CREATE TABLE IF NOT EXISTS vendor_bid_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id              TEXT NOT NULL REFERENCES vendor_bids(id) ON DELETE CASCADE,
  inventory_id        UUID REFERENCES order_lines(id),
  category            TEXT NOT NULL,
  label               TEXT NOT NULL,
  sub_label           TEXT,
  part_number         TEXT,
  offered_qty         INTEGER NOT NULL CHECK (offered_qty > 0),
  offered_unit_price  NUMERIC(12,2) NOT NULL CHECK (offered_unit_price >= 0),
  line_status         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (line_status IN ('pending','accepted','declined')),
  accepted_qty        INTEGER,
  accepted_unit_price NUMERIC(12,2),
  decided_at          TIMESTAMPTZ,
  decided_by          UUID REFERENCES users(id),
  sell_order_id       TEXT REFERENCES sell_orders(id),
  position            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS vendor_bid_lines_bid_idx ON vendor_bid_lines(bid_id);

INSERT INTO id_counters (name, value) VALUES ('VB', 1000)
  ON CONFLICT (name) DO NOTHING;
