-- `warehouses.address` is now derived from the structured ship-to instead of
-- being typed separately (0091 added those columns and left `address` as a
-- second, hand-maintained copy — the two drifted).  Rows that already carry a
-- ship-to would otherwise keep showing their stale free-text line on the
-- warehouse card and in the shipping picker until someone re-saved each one,
-- which reads as "my edit didn't save".
--
-- Rows with no ship_street1 are left alone on purpose: their free text cannot
-- be parsed back into street/city/state/ZIP, and it is still the only address
-- they have.
--
-- The expression is mirrored by syncDerivedAddress() in routes/warehouses.ts.

UPDATE warehouses SET address = NULLIF(concat_ws(', ',
  NULLIF(concat_ws(', ', ship_street1, ship_street2), ''),
  NULLIF(concat_ws(' ', NULLIF(concat_ws(', ', ship_city, ship_state), ''), ship_zip), ''),
  CASE WHEN upper(coalesce(ship_country, 'US')) <> 'US' THEN upper(ship_country) END
), '')
WHERE ship_street1 IS NOT NULL;
