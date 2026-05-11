-- Desktop ERP additions: customers, sell orders, inventory audit log,
-- workflow stage configuration, member admin fields.

-- ── Customers (sell-order counterparties) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  short_name    TEXT,
  contact       TEXT,
  region        TEXT,
  terms         TEXT NOT NULL DEFAULT 'Net 30',
  credit_limit  NUMERIC(12,2),
  tags          TEXT[] NOT NULL DEFAULT '{}',
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customers_name_idx ON customers(name);

-- ── Sell orders (manager packages inventory lines for a customer) ───────────
CREATE TABLE IF NOT EXISTS sell_orders (
  id              TEXT PRIMARY KEY,                  -- e.g. SL-4001
  customer_id     UUID NOT NULL REFERENCES customers(id),
  status          TEXT NOT NULL DEFAULT 'Draft'
                    CHECK (status IN ('Draft','Shipped','Awaiting payment','Done')),
  discount_pct    NUMERIC(6,4) NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sell_orders_status_idx ON sell_orders(status);
CREATE INDEX IF NOT EXISTS sell_orders_customer_idx ON sell_orders(customer_id);

-- ── Sell order lines (denormalized snapshot of the inventory item at sell-time) ─
CREATE TABLE IF NOT EXISTS sell_order_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sell_order_id   TEXT NOT NULL REFERENCES sell_orders(id) ON DELETE CASCADE,
  inventory_id    UUID REFERENCES order_lines(id),    -- source line in stock
  category        TEXT NOT NULL,
  label           TEXT NOT NULL,
  sub_label       TEXT,
  part_number     TEXT,
  qty             INTEGER NOT NULL CHECK (qty > 0),
  unit_price      NUMERIC(12,2) NOT NULL,
  warehouse_id    TEXT REFERENCES warehouses(id),
  condition       TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sell_order_lines_so_idx ON sell_order_lines(sell_order_id);

-- ── Inventory audit log — immutable history of every order_line change ──────
-- Per the chat5 requirement: read-only history; no deletes from the UI.
CREATE TABLE IF NOT EXISTS inventory_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id   UUID NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  actor_id        UUID REFERENCES users(id),
  kind            TEXT NOT NULL,        -- created | edited | status | priced | sold | listed
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS inventory_events_line_idx ON inventory_events(order_line_id, created_at DESC);

-- ── Workflow stage configuration (manager-editable in Settings) ─────────────
CREATE TABLE IF NOT EXISTS workflow_stages (
  id          TEXT PRIMARY KEY,         -- short slug
  label       TEXT NOT NULL,
  short       TEXT NOT NULL,
  tone        TEXT NOT NULL DEFAULT 'muted',
  icon        TEXT NOT NULL DEFAULT 'tag',
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0
);

-- ── Member admin fields (per chat6: managers can reset passwords/disable) ──
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0.075;
