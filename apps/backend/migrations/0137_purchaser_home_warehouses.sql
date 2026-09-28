-- 0137_purchaser_home_warehouses.sql
-- Home warehouse for each purchaser: the closest existing warehouse to where
-- they live.  Keyed by email because these are prod accounts; the join on
-- warehouses makes it a no-op on dev/test databases, which lack those ids.
-- Never overwrites a home warehouse someone has already picked.
UPDATE users u
SET default_warehouse_id = m.wh
FROM (VALUES
  ('tim.wu@recycleservers.com',  'WH-DEN'),
  ('cynthia@recycleservers.com', 'WH-DEN'),
  ('stefen@recycleservers.com',  'WH-DEN'),
  ('ha@recycleservers.com',      'WH-BOSTON'),
  ('chris@recycleservers.com',   'WH-BOSTON')
) AS m(email, wh)
JOIN warehouses w ON w.id = m.wh
WHERE u.email = m.email AND u.default_warehouse_id IS NULL;
