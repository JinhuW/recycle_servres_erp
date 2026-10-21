-- The PO list gains a Paid by column. A saved column list names only the
-- columns that were shown, so without this the new one would start hidden for
-- everyone who has ever toggled a column. No saved list means the defaults,
-- which already include it.
UPDATE users
   SET preferences = preferences
       || jsonb_build_object('orders.cols', (preferences -> 'orders.cols') || '["paidBy"]'::jsonb)
 WHERE jsonb_typeof(preferences -> 'orders.cols') = 'array'
   AND NOT ((preferences -> 'orders.cols') ? 'paidBy');
