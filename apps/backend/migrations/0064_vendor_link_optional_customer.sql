-- General (customer-less) vendor links: one shareable URL not bound to a
-- customer. The customer is assigned by a manager when a resulting bid is
-- promoted to a sell order.

ALTER TABLE vendor_links ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE vendor_bids  ALTER COLUMN customer_id DROP NOT NULL;

-- At most one ACTIVE general link at a time (mirrors the per-customer
-- rotate-on-regenerate pattern). Indexes a constant for every active
-- customer-less row, so a second one violates uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_links_one_active_general
  ON vendor_links ((customer_id IS NULL))
  WHERE customer_id IS NULL AND active = TRUE;
