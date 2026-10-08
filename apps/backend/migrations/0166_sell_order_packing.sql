-- Packing: a sell order whose goods are being boxed. It sits between Draft and
-- Shipped and, like a Draft, reserves nothing (lib/sellCommitment.ts). Pack
-- mode moves a Draft into it.
ALTER TABLE sell_orders DROP CONSTRAINT IF EXISTS sell_orders_status_check;
ALTER TABLE sell_orders ADD CONSTRAINT sell_orders_status_check
  CHECK (status IN ('Draft', 'Packing', 'Shipped', 'Awaiting payment', 'Done', 'Closed'));

INSERT INTO sell_order_statuses (id, label, short_label, tone, needs_meta, position) VALUES
  ('Packing', 'Packing', 'Packing', 'cool', FALSE, 1)
ON CONFLICT (id) DO NOTHING;

UPDATE sell_order_statuses SET position = CASE id
  WHEN 'Draft'            THEN 0
  WHEN 'Packing'          THEN 1
  WHEN 'Shipped'          THEN 2
  WHEN 'Awaiting payment' THEN 3
  WHEN 'Done'             THEN 4
  WHEN 'Closed'           THEN 5
END
WHERE id IN ('Draft', 'Packing', 'Shipped', 'Awaiting payment', 'Done', 'Closed');

-- The packer labels items with their product's #, so once an order is past
-- Draft a product added to it goes after every product already numbered
-- instead of sorting in among them. NULL: numbered with the order's sorted
-- set (every line written before this column existed, and every line added
-- while the order is a Draft). n: added by the n-th save that added lines
-- after the order left Draft. routes/sellOrders.ts numbers by it.
ALTER TABLE sell_order_lines ADD COLUMN append_batch INTEGER CHECK (append_batch > 0);
