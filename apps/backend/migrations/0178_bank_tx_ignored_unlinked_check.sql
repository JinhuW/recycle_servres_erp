-- A payment is either ignored or linked, never both: /link refuses an ignored
-- leg and /ignore a linked one, and the paid total excludes ignored rows, so
-- a row in both states hid money a PO had been told it was paid with. Those
-- two routes used to judge an unlocked read, and a link racing an ignore
-- produced exactly that row (RS-252, BD-03). The routes now lock first; this
-- is the backstop. NOT VALID: a row already in both states keeps what it
-- has — which side was the mistake is a manager's call — and is caught the
-- next time anything writes it.
ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_ignored_unlinked_check
  CHECK (NOT (ignored AND (order_id IS NOT NULL OR sell_order_id IS NOT NULL)))
  NOT VALID;
