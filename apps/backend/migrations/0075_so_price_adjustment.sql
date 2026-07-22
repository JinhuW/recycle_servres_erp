-- Negotiated final-price adjustment metadata on the sell-order header.
--
-- The order total stays computed from lines (0036 invariant: total === sum of
-- lines); an adjustment prorates line prices, and these columns only remember
-- the pre-negotiation baseline so the UI can render "was ¥X" without replaying
-- events. pre_adjust_native_total is in the order's native currency and is set
-- once (first adjustment); adjusted_at/adjusted_by track the latest one. A
-- structural line rewrite (PATCH with lines) clears all three — the old
-- baseline no longer describes the new line set.

ALTER TABLE sell_orders
  ADD COLUMN pre_adjust_native_total NUMERIC(12,2),
  ADD COLUMN adjusted_at TIMESTAMPTZ,
  ADD COLUMN adjusted_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX sell_orders_adjusted_by_idx ON sell_orders(adjusted_by);
