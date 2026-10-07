-- A sell-order line that can't ship is set to 0 instead of removed: a line's
-- # is its place in the order's list, the packer labels items by it, and a
-- removal renumbers every line after it. Creating an order still asks for at
-- least 1 per line, which the app enforces (routes/sellOrders.ts), not this
-- CHECK.
ALTER TABLE sell_order_lines
  DROP CONSTRAINT sell_order_lines_qty_check,
  ADD CONSTRAINT sell_order_lines_qty_check CHECK (qty >= 0);
