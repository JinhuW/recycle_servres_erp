-- Archive flag for purchase orders. `archived_at` is a soft-hide timestamp:
-- the row stays intact (audit trail, sell-order references, commissions) but
-- drops out of the default list view. Reversible by setting back to NULL.
--
-- Distinct from DELETE: hard delete still only works on Draft (no audit
-- consequences) — see routes/orders.ts. Archive is the manager/owner's tool
-- for tidying completed or stalled orders at any non-Draft stage.
--
-- The partial index covers the hot path: the list endpoint defaults to
-- "active only" (archived_at IS NULL), and most orders will be active.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_orders_active_created
  ON orders (created_at DESC)
  WHERE archived_at IS NULL;
