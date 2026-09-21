-- A PO starts at 50% commission. A column default rather than a value each
-- create path writes, so NULL keeps meaning "no rate" for the rows that
-- predate this and for a manager who clears it.
ALTER TABLE orders ALTER COLUMN commission_rate SET DEFAULT 0.5;
