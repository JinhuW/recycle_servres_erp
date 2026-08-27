-- When this box's tracking number was registered with the tracking provider.
-- Shippo's tracking webhooks are explicitly NOT idempotent — a number
-- registered twice pushes two update streams for one box — so registration has
-- to be recorded, not retried blindly. NULL means "not registered yet", which
-- is the truth for every row that predates Shippo.
ALTER TABLE packages ADD COLUMN tracking_registered_at TIMESTAMPTZ;

-- The sweep that registers stragglers on each tracking tick.
CREATE INDEX packages_unregistered_idx ON packages (created_at)
  WHERE tracking_registered_at IS NULL
    AND status IN ('purchased','in_transit','exception');
