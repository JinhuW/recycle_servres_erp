-- Indexes on FK / join columns that were unindexed: parent deletes and the
-- sell-order ↔ inventory joins (validateSellLines, the committed-line guard,
-- transfer-order reopen/receive, the transfer-orders list) were doing
-- sequential scans. Idempotent — migrate.mjs / resetDb may replay this.

-- Heavily queried by the one-open-sell-order-per-line invariant and
-- inventory.get('/:id/sell-orders').
CREATE INDEX IF NOT EXISTS sell_order_lines_inventory_idx
  ON sell_order_lines(inventory_id);

-- FK → users(id); supports user-deactivation and "who created it" joins.
CREATE INDEX IF NOT EXISTS sell_orders_created_by_idx
  ON sell_orders(created_by);
CREATE INDEX IF NOT EXISTS transfer_orders_created_by_idx
  ON transfer_orders(created_by);
CREATE INDEX IF NOT EXISTS transfer_orders_received_by_idx
  ON transfer_orders(received_by);

-- Joined by the 0031 RAM-generation backfill (label_scans.cf_image_id) and
-- any scan-image lookup.
CREATE INDEX IF NOT EXISTS order_lines_scan_image_idx
  ON order_lines(scan_image_id);
