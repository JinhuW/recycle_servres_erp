-- Discount-per-sell-order is removed from the product. The unit_price on each
-- sell_order_line is now the authoritative customer-facing price; total ===
-- subtotal everywhere.
ALTER TABLE sell_orders DROP COLUMN IF EXISTS discount_pct;
