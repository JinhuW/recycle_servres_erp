-- 0151 keyed a name on its exact text only when no A–Z or 0–9 survived the
-- compression, so a name mixing scripts still collapsed to its Latin residue:
-- 'Đức' keyed as 'C', and '王 RAM' and '李 RAM' both as 'RAM'. Two such clients
-- with one zip hit the unique index, and a web-submission upsert filed one
-- seller's lot under the other.
--
-- A name carrying any non-ASCII character now keys on its whole text (trimmed,
-- runs of whitespace folded, lower-cased). That errs toward a missed duplicate
-- — a second supplier row — over a false merge. An ASCII name keys exactly as
-- before; one that compresses to nothing keeps 0151's 'U:' fallback. Prod had
-- one supplier and no non-ASCII names on 2026-10-02. A dismissal keyed on an
-- old residue stops matching, and that seller is suggested again.

-- Replacing the function would leave the stored keys as they were, so the
-- generated column is rebuilt around it as in 0151, indexes included. STORED
-- is spelled out: PG18 makes a generated column VIRTUAL by default, and that
-- can't be indexed.
DROP INDEX IF EXISTS suppliers_owner_match_idx;
DROP INDEX IF EXISTS suppliers_match_key_idx;
ALTER TABLE suppliers DROP COLUMN match_key;

CREATE OR REPLACE FUNCTION supplier_name_key(name TEXT) RETURNS TEXT
  LANGUAGE SQL IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN name !~ '[^\x01-\x7f]' AND regexp_replace(upper(name), '[^A-Z0-9]', '', 'g') <> ''
      THEN regexp_replace(upper(name), '[^A-Z0-9]', '', 'g')
    ELSE 'U:' || lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
  END;

ALTER TABLE suppliers ADD COLUMN match_key TEXT GENERATED ALWAYS AS (
  supplier_name_key(name) || '|' || COALESCE(zip, '')
) STORED;
CREATE UNIQUE INDEX suppliers_owner_match_idx
  ON suppliers (owner_id, match_key) NULLS NOT DISTINCT;
CREATE INDEX suppliers_match_key_idx ON suppliers (match_key);
