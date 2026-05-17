-- Per-order commission rate set by a manager in the PO detail. Nullable with
-- NO default: NULL means "manager has not set a rate" = $0 commission. The
-- old tiered model, commission_settings and users.commission_rate are dropped
-- in a later step of the same migration (added once all code is migrated off
-- them). Idempotent: the runner re-applies every migration each run.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,4);

-- Old commission model fully removed (all code is migrated off it). Idempotent.
DROP TABLE IF EXISTS commission_tiers CASCADE;
DROP TABLE IF EXISTS commission_settings CASCADE;
ALTER TABLE users DROP COLUMN IF EXISTS commission_rate;
