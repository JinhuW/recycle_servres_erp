-- The sell_order_close_reasons lookup table was overbuilt for what is a fixed
-- enum (the design doc itself listed the five values upfront, and we never
-- shipped an admin UI to edit them). Swap the FK for a CHECK constraint and
-- drop the table. Labels move to frontend i18n so they translate through
-- useT() instead of being served as English-only DB strings.

ALTER TABLE sell_orders
  DROP CONSTRAINT IF EXISTS sell_orders_close_reason_id_fkey;

ALTER TABLE sell_orders
  ADD CONSTRAINT sell_orders_close_reason_id_check
  CHECK (
    close_reason_id IS NULL
    OR close_reason_id IN ('customer_cancelled','lost_deal','returned','duplicate','other')
  );

DROP TABLE IF EXISTS sell_order_close_reasons;
