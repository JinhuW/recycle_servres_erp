-- sell_order_lines.inventory_id (0002_desktop.sql, line 39) had no ON DELETE
-- rule, so Postgres refused to delete a PO line that any sell order had ever
-- named — archived ones included, which the FK cannot tell apart. Which sell
-- orders still hold a line is the route's decision (routes/orders.ts refuses
-- while a non-archived one names it); the FK only has to stop dangling ids.
-- The column has been nullable since 0002 (vendor-bid lines are created
-- unlinked) and every reader tolerates NULL, so an archived sell order keeps
-- its denormalised snapshot and just loses the link.

ALTER TABLE sell_order_lines
  DROP CONSTRAINT IF EXISTS sell_order_lines_inventory_id_fkey,
  ADD CONSTRAINT sell_order_lines_inventory_id_fkey
    FOREIGN KEY (inventory_id) REFERENCES order_lines(id) ON DELETE SET NULL;
