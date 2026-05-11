-- apps/backend/migrations/0003_fix_lifecycle_default.sql
-- Fix the default lifecycle for new orders. Previous default was
-- 'awaiting_payment' which doesn't exist in the workflow_stages table.

ALTER TABLE orders ALTER COLUMN lifecycle SET DEFAULT 'draft';

-- Backfill any existing rows that were wrongly seeded with the old default.
UPDATE orders SET lifecycle = 'draft' WHERE lifecycle = 'awaiting_payment';
