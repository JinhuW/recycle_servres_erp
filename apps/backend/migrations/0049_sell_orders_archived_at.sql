-- Archive flag for sell orders. `archived_at` is a soft-hide timestamp:
-- the row stays intact (commission history, references, audit trail) but
-- drops out of the default list view. Reversible by setting back to NULL.
--
-- Distinct from DELETE: hard delete still only works on Draft (no audit
-- consequences). Archive is the manager's tool for tidying completed or
-- stalled sell orders at any non-Draft status.
--
-- The partial index covers the hot path: the list endpoint defaults to
-- "active only" (archived_at IS NULL), and most orders will be active.

ALTER TABLE sell_orders
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_sell_orders_active_created
  ON sell_orders (created_at DESC)
  WHERE archived_at IS NULL;
