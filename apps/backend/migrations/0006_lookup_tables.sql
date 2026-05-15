-- Move hardcoded dropdown / status / source lists out of the frontend bundle
-- and the backend route handlers into proper lookup tables. The frontend
-- fetches these at boot via /api/lookups; backend handlers read them on demand.

-- ── Catalog options (RAM/SSD spec dropdowns, conditions) ────────────────────
-- One row per (group, value). `group` mirrors the constant name used to live
-- in apps/frontend/src/lib/catalog.ts (RAM_BRAND, SSD_INTERFACE, etc.).
CREATE TABLE IF NOT EXISTS catalog_options (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "group"   TEXT NOT NULL,
  value     TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE ("group", value)
);
CREATE INDEX IF NOT EXISTS catalog_options_group_idx
  ON catalog_options("group", position);

-- ── Payment terms (customers.terms is a free TEXT field; this is the picker) ─
CREATE TABLE IF NOT EXISTS payment_terms (
  label     TEXT PRIMARY KEY,
  position  INTEGER NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE
);

-- ── Reference price sources (broker quotes / market indices) ────────────────
-- Surfaced on the Market page so the explainer copy ("based on N data points
-- across X sources") can be honest about where prices come from.
CREATE TABLE IF NOT EXISTS price_sources (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE
);

-- ── Sell-order statuses (was an inline tuple in DesktopSellOrders + the
-- backend route). The list still matches the CHECK constraint on
-- sell_orders.status; this table just adds presentation metadata and the
-- "needs evidence" flag that previously lived as META_STATUSES.
CREATE TABLE IF NOT EXISTS sell_order_statuses (
  id          TEXT PRIMARY KEY,           -- e.g. 'Draft', 'Shipped' (matches sell_orders.status)
  label       TEXT NOT NULL,              -- display label
  short_label TEXT NOT NULL,              -- pipeline chip ('Awaiting pay' for 'Awaiting payment')
  tone        TEXT NOT NULL DEFAULT 'muted',
  needs_meta  BOOLEAN NOT NULL DEFAULT FALSE,  -- requires note + attachments when entered
  position    INTEGER NOT NULL DEFAULT 0
);
