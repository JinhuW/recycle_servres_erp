-- A bank row links to one of three things: a purchase order's cost (as
-- before), a purchase order's commission (link_kind = 'commission'), or a
-- sell order. "Linked" is linked_at IS NOT NULL; the CHECKs below make that
-- equivalent to exactly one of order_id / sell_order_id being set.
--
-- SET NULL mirrors order_id, which is why a DELETE FROM sell_orders on a
-- linked row trips the linked_at CHECK: no route deletes a sell order, and the
-- PO delete clears its links first (routes/orders/lifecycle.ts). A fixture that
-- bulk-deletes sell orders has to unlink them the same way.
ALTER TABLE bank_transactions
  ADD COLUMN sell_order_id TEXT REFERENCES sell_orders(id) ON DELETE SET NULL;

CREATE INDEX bank_transactions_sell_order_id_idx ON bank_transactions (sell_order_id);

-- 0100 left the two link CHECKs and the link_kind CHECK unnamed, so they are
-- found by definition rather than by name.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'bank_transactions'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ 'linked_at|link_kind'
  LOOP
    EXECUTE format('ALTER TABLE bank_transactions DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE bank_transactions
  DROP CONSTRAINT bank_transactions_assignee_unlinked,
  ADD CONSTRAINT bank_transactions_link_kind_check
    CHECK (link_kind IN ('payment', 'refund', 'commission')),
  ADD CONSTRAINT bank_transactions_one_target
    CHECK (order_id IS NULL OR sell_order_id IS NULL),
  ADD CONSTRAINT bank_transactions_linked_at_pair
    CHECK ((order_id IS NULL AND sell_order_id IS NULL) = (linked_at IS NULL)),
  ADD CONSTRAINT bank_transactions_link_kind_pair
    CHECK ((order_id IS NULL AND sell_order_id IS NULL) = (link_kind IS NULL)),
  ADD CONSTRAINT bank_transactions_commission_on_po
    CHECK (link_kind <> 'commission' OR order_id IS NOT NULL),
  -- Re-stated over both targets: a payment is owned by a person or settled by
  -- an order, never both.
  ADD CONSTRAINT bank_transactions_assignee_unlinked
    CHECK (assignee_id IS NULL OR (order_id IS NULL AND sell_order_id IS NULL));
