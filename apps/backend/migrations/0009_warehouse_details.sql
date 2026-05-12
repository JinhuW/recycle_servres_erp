-- 0009_warehouse_details.sql
-- Persist warehouse detail fields that previously lived in a hardcoded
-- frontend lookup (WAREHOUSE_EXTRAS in DesktopSettings.tsx).

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS address        TEXT,
  ADD COLUMN IF NOT EXISTS manager        TEXT,
  ADD COLUMN IF NOT EXISTS manager_phone  TEXT,
  ADD COLUMN IF NOT EXISTS manager_email  TEXT,
  ADD COLUMN IF NOT EXISTS timezone       TEXT,
  ADD COLUMN IF NOT EXISTS cutoff_local   TEXT,  -- 'HH:MM' in the warehouse's tz
  ADD COLUMN IF NOT EXISTS sqft           INTEGER;

-- Backfill the values that were hardcoded in the frontend, keyed by short code.
-- Manager phone/email were not in the hardcoded data, so they stay NULL.

UPDATE warehouses SET
  address      = '2401 E. 8th St, Los Angeles, CA 90021',
  manager      = 'Operations · West',
  timezone     = 'America/Los_Angeles',
  cutoff_local = '15:00',
  sqft         = 14200
WHERE short = 'LA1';

UPDATE warehouses SET
  address      = '6900 Ambassador Row, Dallas, TX 75247',
  manager      = 'Operations · Central',
  timezone     = 'America/Chicago',
  cutoff_local = '14:00',
  sqft         = 9800
WHERE short = 'DAL';

UPDATE warehouses SET
  address      = '180 Raymond Blvd, Newark, NJ 07102',
  manager      = 'Operations · East',
  timezone     = 'America/New_York',
  cutoff_local = '16:00',
  sqft         = 11600
WHERE short = 'NJ2';

UPDATE warehouses SET
  address      = 'Unit 12, Goodman Tsing Yi, Hong Kong',
  manager      = 'APAC Hub',
  timezone     = 'Asia/Hong_Kong',
  cutoff_local = '17:00',
  sqft         = 8200
WHERE short = 'HK';

UPDATE warehouses SET
  address      = 'Schiphol Logistics Park, 1118 BE Amsterdam',
  manager      = 'EMEA Hub',
  timezone     = 'Europe/Amsterdam',
  cutoff_local = '16:00',
  sqft         = 7400
WHERE short = 'AMS';
