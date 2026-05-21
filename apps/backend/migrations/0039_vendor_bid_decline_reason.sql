-- Vendor bid lines: capture a reason when an "accepted" decision falls
-- through (typically because the referenced inventory has been closed /
-- consumed since the bid landed). Surfaced to the vendor on the public
-- bid-status page so they see the truth instead of a silent zero-qty
-- "accepted" row.

ALTER TABLE vendor_bid_lines
  ADD COLUMN IF NOT EXISTS decline_reason TEXT;
