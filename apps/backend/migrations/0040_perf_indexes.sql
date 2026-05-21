-- Performance indexes for high-frequency query paths. Idempotent — migrate.mjs
-- and resetDb may replay this.

-- /api/inventory list — ORDER BY order_lines.created_at DESC
CREATE INDEX IF NOT EXISTS order_lines_created_at_idx
  ON order_lines(created_at DESC);

-- /api/dashboard KPI / chart / leaderboard queries — filter by status, sort by updated_at
CREATE INDEX IF NOT EXISTS sell_orders_status_updated_idx
  ON sell_orders(status, updated_at DESC);

-- Public /api/public/vendor/:token/catalog scan — filter by status, sort by created_at
CREATE INDEX IF NOT EXISTS order_lines_status_created_idx
  ON order_lines(status, created_at DESC);
