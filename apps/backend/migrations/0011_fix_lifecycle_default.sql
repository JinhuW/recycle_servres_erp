-- Fix the default lifecycle for new orders. The original default in
-- 0001_init.sql ('awaiting_payment') is not a value in workflow_stages
-- (draft/in_transit/reviewing/done), which breaks lifecycle transitions.
-- The route insert was already corrected to 'draft'; this aligns the column
-- default and backfills rows mis-seeded with the old value. Idempotent.

ALTER TABLE orders ALTER COLUMN lifecycle SET DEFAULT 'draft';

UPDATE orders SET lifecycle = 'draft' WHERE lifecycle = 'awaiting_payment';
