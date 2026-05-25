-- Add 'Closed' to sell_orders.status. Closed is an off-ramp from Draft /
-- Shipped / Awaiting payment for deals that won't complete. Distinct from
-- Done: Done consumed inventory + fired commission; Closed just terminates
-- and releases the soft-commit so the inventory lines can be sold elsewhere.
--
-- See docs/superpowers/specs/2026-05-25-sell-order-close-workflow-design.md.

ALTER TABLE sell_orders DROP CONSTRAINT IF EXISTS sell_orders_status_check;
ALTER TABLE sell_orders ADD CONSTRAINT sell_orders_status_check
  CHECK (status IN ('Draft','Shipped','Awaiting payment','Done','Closed'));

-- Reason taxonomy. Lookup, not enum, so adding a reason is a seed change.
CREATE TABLE IF NOT EXISTS sell_order_close_reasons (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE
);

-- Denormalized current close-reason. Close is exactly-once per close-cycle
-- (reopen clears it). Joining to sell_order_events for the current reason
-- on every list/detail render is wasteful; the column carries it directly.
-- Reopen history still lives in sell_order_events.
ALTER TABLE sell_orders
  ADD COLUMN IF NOT EXISTS close_reason_id TEXT
    REFERENCES sell_order_close_reasons(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS sell_orders_close_reason_idx
  ON sell_orders(close_reason_id) WHERE close_reason_id IS NOT NULL;
