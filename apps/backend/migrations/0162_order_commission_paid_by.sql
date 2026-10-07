-- Which manager paid the purchaser their commission. The Commission bucket's
-- screenshot (0129, 0131) shows that it was paid; this names who paid it —
-- the screenshot's uploader need not be the payer.
--
-- NULL means nobody has recorded it, and every existing order starts there:
-- no backfill, because a guess from the uploader or the PO manager would be
-- indistinguishable from a real record. SET NULL on delete, like the other
-- people columns on orders; the activity log keeps the name as it was.
ALTER TABLE orders
  ADD COLUMN commission_paid_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS orders_commission_paid_by_idx
  ON orders(commission_paid_by);
