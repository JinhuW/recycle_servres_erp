-- Structured ship-to address for prepaid shipping labels. The existing
-- free-text `address` column stays as the human-facing display line; carriers
-- need discrete fields, so labels read these instead. A warehouse counts as
-- shippable when street1/city/state/zip are all present — enforced in the
-- shipments routes, not by a CHECK, because most warehouses legitimately
-- predate the feature.

ALTER TABLE warehouses
  ADD COLUMN ship_contact_name TEXT,
  ADD COLUMN ship_phone        TEXT,
  ADD COLUMN ship_street1      TEXT,
  ADD COLUMN ship_street2      TEXT,
  ADD COLUMN ship_city         TEXT,
  ADD COLUMN ship_state        TEXT,
  ADD COLUMN ship_zip          TEXT,
  ADD COLUMN ship_country      TEXT;
