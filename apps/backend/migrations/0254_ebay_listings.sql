-- The eBay desk: a manager sends part of an inventory lot to eBay as a listing,
-- the eBay operator (role 'ebay') posts it and records what sold, and each
-- confirmed sale becomes a sell order to the customer "eBay". The workflow and
-- its transition table live in routes/ebay.ts.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('manager', 'purchaser', 'ebay'));

INSERT INTO id_counters (name, value) VALUES ('EB', 100)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE ebay_listings (
  id             TEXT PRIMARY KEY,                 -- EB-n
  -- SET NULL, like sell_order_lines: a PO edit may delete the lot, and the
  -- listing then stays as the record of what was offered. Not unique: a lot
  -- of mixed specs (20 sticks of assorted 16/32GB) is sold as several items.
  inventory_id   UUID REFERENCES order_lines(id) ON DELETE SET NULL,
  -- Units offered. What is still for sale is qty less the Confirmed sales;
  -- while Queued or Listed that remainder is reserved (lib/sellCommitment.ts).
  qty            INTEGER NOT NULL CHECK (qty > 0),
  list_price     NUMERIC(12,2) NOT NULL CHECK (list_price >= 0),   -- USD, per unit
  title          TEXT,
  -- Which part of the lot this item is, e.g. "16GB 2Rx8 DDR4-2666".
  spec           TEXT,
  condition      TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Listed', 'Sold', 'Ended')),
  -- The SKU the ERP publishes under, so a synced eBay order finds its listing.
  ebay_sku       TEXT GENERATED ALWAYS AS ('RS-' || id) STORED UNIQUE,
  ebay_offer_id  TEXT,
  ebay_item_id   TEXT,
  ebay_url       TEXT,
  end_reason     TEXT CHECK (end_reason IN ('no_buyer', 'damaged', 'sold_elsewhere', 'other', 'cancelled')),
  end_note       TEXT,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  listed_at      TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  sold_out_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'Ended') = (end_reason IS NOT NULL)),
  CHECK ((status = 'Ended') = (ended_at IS NOT NULL)),
  CHECK ((status = 'Sold') = (sold_out_at IS NOT NULL))
);
CREATE INDEX ebay_listings_inventory_id_idx ON ebay_listings(inventory_id);
CREATE INDEX ebay_listings_created_by_idx ON ebay_listings(created_by);
CREATE INDEX ebay_listings_status_created_idx ON ebay_listings(status, created_at DESC, id DESC);
-- One eBay item is one listing; a hand-linked item # can't be claimed twice.
CREATE UNIQUE INDEX ebay_listings_item_id_key ON ebay_listings(ebay_item_id) WHERE ebay_item_id IS NOT NULL;

-- A listing can sell in parts, so each sale is its own row. Detected rows come
-- from the eBay sync and wait for the operator; Confirmed ones carry the sell
-- order they became.
CREATE TABLE ebay_sales (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id         TEXT NOT NULL REFERENCES ebay_listings(id) ON DELETE CASCADE,
  qty                INTEGER NOT NULL CHECK (qty > 0),
  unit_price         NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),   -- USD
  fees               NUMERIC(12,2) CHECK (fees >= 0),
  ebay_order_id      TEXT,
  ebay_line_item_id  TEXT,
  buyer              TEXT,
  sold_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL CHECK (status IN ('Detected', 'Confirmed', 'Dismissed')),
  sell_order_id      TEXT REFERENCES sell_orders(id) ON DELETE SET NULL,
  confirmed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ebay_sales_listing_id_idx ON ebay_sales(listing_id);
CREATE INDEX ebay_sales_sell_order_id_idx ON ebay_sales(sell_order_id);
CREATE INDEX ebay_sales_confirmed_by_idx ON ebay_sales(confirmed_by);
CREATE INDEX ebay_sales_detected_idx ON ebay_sales(sold_at DESC) WHERE status = 'Detected';
-- The sync upserts on this, so running it twice can't count a sale twice.
CREATE UNIQUE INDEX ebay_sales_line_item_key ON ebay_sales(ebay_order_id, ebay_line_item_id)
  WHERE ebay_line_item_id IS NOT NULL;

CREATE TABLE ebay_listing_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   TEXT NOT NULL REFERENCES ebay_listings(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'created', 'edited', 'listed', 'sale_detected', 'sale_confirmed', 'sale_dismissed',
                 'sold', 'ended')),
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ebay_listing_events_listing_idx ON ebay_listing_events(listing_id, created_at);
CREATE INDEX ebay_listing_events_actor_id_idx ON ebay_listing_events(actor_id);
-- The Activity feed's keyset, as 0079 gives the other ledgers.
CREATE INDEX ebay_listing_events_feed_idx ON ebay_listing_events(created_at DESC, id DESC);

-- Append-only, as 0012/0038 made inventory_events: a cascade from a deleted
-- listing may remove rows, a direct UPDATE or DELETE may not.
CREATE OR REPLACE FUNCTION ebay_listing_events_lock() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ebay_listing_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ebay_listing_events_no_update BEFORE UPDATE ON ebay_listing_events
  FOR EACH ROW EXECUTE FUNCTION ebay_listing_events_lock();
CREATE TRIGGER ebay_listing_events_no_delete BEFORE DELETE ON ebay_listing_events
  FOR EACH ROW EXECUTE FUNCTION ebay_listing_events_lock();

-- The customer every eBay sale is sold to. Prod may already have one by that
-- name, which is then the one used (routes/ebay.ts looks it up by name).
INSERT INTO customers (name, short_name, notes)
SELECT 'eBay', 'eBay', 'eBay buyers. Sell orders here are created by the eBay desk.'
WHERE NOT EXISTS (SELECT 1 FROM customers WHERE lower(name) = 'ebay');
