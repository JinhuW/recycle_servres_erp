-- Every proof-of-payment rule on the way out of Draft tests payment for
-- exactly 'company' or 'self'; any other string slipped past all of them.
ALTER TABLE orders
  ADD CONSTRAINT orders_payment_ck CHECK (payment IN ('company', 'self'));
