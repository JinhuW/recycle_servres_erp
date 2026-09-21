-- The commission payment is the screenshot alone. 0129 also recorded a method
-- (PayPal / cash) and a PayPal transaction id read off the screenshot; neither
-- is wanted, so the columns go. The 'Commission' status-meta bucket from 0129
-- stays — it is the whole record now. Dev-only columns, no rows to carry over.
ALTER TABLE orders
  DROP COLUMN commission_method,
  DROP COLUMN commission_txn_id;
