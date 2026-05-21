-- 0041_fk_on_delete.sql
-- Make implicit RESTRICT semantics explicit on customer_id FKs that had no
-- ON DELETE clause. RESTRICT is the correct choice: deleting a customer that
-- has vendor bids or sell orders is a data-integrity error, not a cascade.

-- vendor_bids.customer_id (added in 0033_vendor_bidding.sql, line 19)
ALTER TABLE vendor_bids
  DROP CONSTRAINT IF EXISTS vendor_bids_customer_id_fkey,
  ADD CONSTRAINT vendor_bids_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;

-- sell_orders.customer_id (added in 0002_desktop.sql, line 23)
ALTER TABLE sell_orders
  DROP CONSTRAINT IF EXISTS sell_orders_customer_id_fkey,
  ADD CONSTRAINT sell_orders_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
