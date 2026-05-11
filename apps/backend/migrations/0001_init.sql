-- Recycle Servers ERP — initial schema
-- Single-file migration; idempotent so re-running is safe in dev.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  initials        TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('manager','purchaser')),
  team            TEXT,
  password_hash   TEXT NOT NULL,
  language        TEXT NOT NULL DEFAULT 'en',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Warehouses (small reference table) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouses (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  short   TEXT NOT NULL,
  region  TEXT NOT NULL
);

-- ── Orders (one purchaser submission, one or many lines) ────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  warehouse_id    TEXT REFERENCES warehouses(id),
  payment         TEXT NOT NULL DEFAULT 'company',
  notes           TEXT,
  total_cost      NUMERIC(12,2),
  lifecycle       TEXT NOT NULL DEFAULT 'awaiting_payment',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS orders_user_id_idx     ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_created_at_idx  ON orders(created_at DESC);

-- ── Order line items ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  brand             TEXT,
  capacity          TEXT,
  type              TEXT,
  classification    TEXT,
  rank              TEXT,
  speed             TEXT,
  interface         TEXT,
  form_factor       TEXT,
  description       TEXT,
  part_number       TEXT,
  condition         TEXT NOT NULL DEFAULT 'Pulled — Tested',
  qty               INTEGER NOT NULL CHECK (qty > 0),
  unit_cost         NUMERIC(12,2) NOT NULL,
  sell_price        NUMERIC(12,2),
  status            TEXT NOT NULL DEFAULT 'In Transit',
  scan_image_id     TEXT,
  scan_confidence   REAL,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_lines_order_id_idx ON order_lines(order_id);

-- ── Reference market prices (purchaser-facing) ──────────────────────────────
CREATE TABLE IF NOT EXISTS ref_prices (
  id                TEXT PRIMARY KEY,
  category          TEXT NOT NULL,
  brand             TEXT,
  capacity          TEXT,
  type              TEXT,
  classification    TEXT,
  speed             TEXT,
  interface         TEXT,
  form_factor       TEXT,
  description       TEXT,
  part_number       TEXT,
  label             TEXT NOT NULL,
  sub_label         TEXT,
  target            NUMERIC(12,2) NOT NULL,
  low_price         NUMERIC(12,2) NOT NULL,
  high_price        NUMERIC(12,2) NOT NULL,
  avg_sell          NUMERIC(12,2) NOT NULL,
  trend             REAL NOT NULL DEFAULT 0,
  samples           INTEGER NOT NULL DEFAULT 0,
  source            TEXT,
  stock             INTEGER NOT NULL DEFAULT 0,
  demand            TEXT NOT NULL DEFAULT 'medium',
  history           JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ref_prices_category_idx ON ref_prices(category);

-- ── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  tone        TEXT NOT NULL DEFAULT 'info',
  icon        TEXT NOT NULL DEFAULT 'bell',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  unread      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);

-- ── Label scan audit trail (uploads → AI extraction) ────────────────────────
CREATE TABLE IF NOT EXISTS label_scans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cf_image_id     TEXT NOT NULL,
  delivery_url    TEXT,
  category        TEXT NOT NULL,
  extracted       JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence      REAL NOT NULL DEFAULT 0,
  provider        TEXT NOT NULL DEFAULT 'stub',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS label_scans_user_idx ON label_scans(user_id, created_at DESC);
