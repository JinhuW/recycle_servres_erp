-- Indexes for the read-time PO match on the Payments page: the candidate pool
-- is a range on total_cost intersected with a date window, and the
-- counterparty affinity signal scans linked rows by counterparty.
CREATE INDEX IF NOT EXISTS orders_total_cost_created_at_idx
  ON orders (total_cost, created_at) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS bank_transactions_counterparty_linked_idx
  ON bank_transactions (counterparty) WHERE order_id IS NOT NULL;
