-- How many times a city's gap this item waits between searches, so one item can
-- run less often than another in every city without touching per_day.
ALTER TABLE fleet_items
  ADD COLUMN every_days integer NOT NULL DEFAULT 1 CHECK (every_days BETWEEN 1 AND 30);
