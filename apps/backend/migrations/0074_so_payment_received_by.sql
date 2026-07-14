-- Who physically received the customer's payment for a sell order.
-- Optional; set from the sell-order form. SET NULL keeps orders intact if a
-- user row is ever hard-deleted (deactivation is the normal path).
ALTER TABLE sell_orders
  ADD COLUMN payment_received_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sell_orders_payment_received_by_idx
  ON sell_orders(payment_received_by);
