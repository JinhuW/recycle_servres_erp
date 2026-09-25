-- The Mercury sync now also walks the IO credit card, which it never fetched
-- before. The sync window starts at the oldest account cursor, so rewinding
-- the existing ones makes the next run pull the card from before it was
-- opened (2026-01). Re-fetching old checking rows is the same idempotent
-- upsert the overlap does every run; the run resets every cursor after.
UPDATE bank_accounts SET sync_cursor = '2026-01-01T00:00:00Z' WHERE source = 'mercury';
