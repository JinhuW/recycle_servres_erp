-- A supplier's identity key, for names with no Latin letters or digits too.
--
-- match_key compressed a name to its A–Z/0–9 characters, so every name written
-- in another script (王, Đức, …) compressed to '' and they all collided: a
-- second such client with the same zip hit the unique index, and the
-- suggestions rail matched every non-Latin seller to every non-Latin client.
-- Such a name now keys as 'U:' + its trimmed lower-case text. A Latin name
-- keys exactly as before, so no existing key changes. Prod had no empty key
-- on 2026-10-02.
--
-- One SQL function, so the generated column, the suggestions, the package
-- adoption and the create-time duplicate lookup cannot disagree (see the note
-- in 0113 on why this is never re-implemented in TypeScript).
CREATE OR REPLACE FUNCTION supplier_name_key(name TEXT) RETURNS TEXT
  LANGUAGE SQL IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN regexp_replace(upper(name), '[^A-Z0-9]', '', 'g') <> ''
      THEN regexp_replace(upper(name), '[^A-Z0-9]', '', 'g')
    ELSE 'U:' || lower(btrim(name))
  END;

-- PG16 has no ALTER COLUMN … SET EXPRESSION, so the generated column is
-- rebuilt. Its two indexes go with it and come back exactly: the unique one is
-- what webSubmissions.ts's ON CONFLICT (owner_id, match_key) infers.
DROP INDEX IF EXISTS suppliers_owner_match_idx;
DROP INDEX IF EXISTS suppliers_match_key_idx;
ALTER TABLE suppliers DROP COLUMN match_key;
ALTER TABLE suppliers ADD COLUMN match_key TEXT GENERATED ALWAYS AS (
  supplier_name_key(name) || '|' || COALESCE(zip, '')
) STORED;
CREATE UNIQUE INDEX suppliers_owner_match_idx
  ON suppliers (owner_id, match_key) NULLS NOT DISTINCT;
CREATE INDEX suppliers_match_key_idx ON suppliers (match_key);

-- A dismissal keyed '' stood for every non-Latin seller at once; which one was
-- meant is gone, so it goes too and the seller is suggested again.
DELETE FROM supplier_suggestion_dismissals WHERE match_key = '';
