-- The vendor bid portal is removed: no bid was ever placed in production.
-- Dropping the tables rather than orphaning them also drops
-- vendor_bid_lines.inventory_id → order_lines (NO ACTION), which would
-- otherwise keep blocking deletes of any PO line a bid had ever named.
DROP TABLE IF EXISTS vendor_bid_lines;
DROP TABLE IF EXISTS vendor_bids;
DROP TABLE IF EXISTS vendor_links;
DELETE FROM id_counters WHERE name = 'VB';

-- Written only by the generic /api/attachments route, which nothing called;
-- status-change and photo uploads have their own tables.
DROP TABLE IF EXISTS attachments;
