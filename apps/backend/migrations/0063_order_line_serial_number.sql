-- Optional per-lot serial numbers. Stored as a single free-text blob (one SN
-- per line) so a lot of qty > 1 can list every unit's serial without needing a
-- separate child table. Null/empty means "not recorded".
ALTER TABLE order_lines ADD COLUMN serial_number TEXT;
