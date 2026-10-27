-- 0216: the city pin goes. It was kept for tiers, which were never built, and
-- the scheduler never read it: per_day alone sets how often a city is searched,
-- so the cities that were pinned keep their count and read as plain enabled.

ALTER TABLE fleet_cities DROP COLUMN pinned;
