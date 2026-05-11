CREATE INDEX IF NOT EXISTS order_lines_part_number_status_idx ON order_lines(part_number, status);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id, unread, created_at DESC);
CREATE INDEX IF NOT EXISTS sell_orders_created_at_idx ON sell_orders(created_at DESC);
