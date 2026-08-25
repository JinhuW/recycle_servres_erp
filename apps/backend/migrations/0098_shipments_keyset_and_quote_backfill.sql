-- The cross-PO list pages on (created_at, id) < (ts, id) with
-- ORDER BY created_at DESC, id DESC (shipmentsGlobal.ts); 0094's
-- single-column index can't serve the id tiebreaker.
CREATE INDEX shipments_created_at_id_idx ON shipments (created_at DESC, id DESC);
DROP INDEX shipments_created_at_idx;

-- Pre-0095 rows reached 'quoted' before quotes were persisted; buy resolves
-- the picked rate against the stored quotes, so these 409 until re-quoted.
-- 'draft' is the honest state and makes the UI offer "Get rates" naturally.
UPDATE shipments SET status = 'draft' WHERE status = 'quoted' AND quotes IS NULL;
