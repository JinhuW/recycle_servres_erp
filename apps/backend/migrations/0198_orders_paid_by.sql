-- Who paid the supplier, when a person did. `payment` (0143) still says which
-- kind of money it was: 'company' is the Business Account — the Mercury and
-- PayPal accounts the Payments page reconciles, the only kind auto-link
-- touches — and 'self' is somebody's own. Until now 'self' could only mean
-- the purchaser; a manager who paid a purchaser's order from their own
-- pocket had no way to say so, and the Accounting book had no one to book
-- the cost to. This names the person.
--
-- NULL on a Business Account order, and the routes keep it that way; no
-- cross-column CHECK, for the reason 0126 gives for payment_method. The
-- backfill names the purchaser on every self-paid order: that is who the
-- commission maths has been reimbursing all along, so the record matches
-- the books. SET NULL on delete like the other people columns on orders;
-- the activity log keeps the name as it was.
ALTER TABLE orders
  ADD COLUMN paid_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX orders_paid_by_idx ON orders(paid_by);

UPDATE orders SET paid_by = user_id WHERE payment = 'self';
