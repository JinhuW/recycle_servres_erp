-- How the purchaser was paid their commission — the second payment on a PO,
-- next to the cost payment the hand-off records (0126). Method and PayPal
-- transaction id live on the order; the screenshot goes in its own status-meta
-- bucket, 'Commission', so it is never mistaken for cost proof ('Payment').
--
-- commission_method is nullable: NULL means nobody has recorded it. The picker
-- opens on PayPal, so the first real choice is an audited change rather than a
-- default every historical order silently claims. No cutoff setting: the record
-- is optional and gates nothing.
ALTER TABLE orders
  ADD COLUMN commission_method TEXT CHECK (commission_method IN ('paypal','cash')),
  ADD COLUMN commission_txn_id TEXT;

ALTER TABLE order_status_meta
  DROP CONSTRAINT order_status_meta_status_check,
  ADD  CONSTRAINT order_status_meta_status_check
    CHECK (status IN ('Submission', 'Done', 'Payment', 'Commission'));

ALTER TABLE order_status_attachments
  DROP CONSTRAINT order_status_attachments_status_check,
  ADD  CONSTRAINT order_status_attachments_status_check
    CHECK (status IN ('Submission', 'Done', 'Payment', 'Commission'));
