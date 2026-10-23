-- Runs inside the restore transaction, right after prod's dump lands on dev.
--
-- Dev is a copy of prod for testing against real data, not a second way into
-- prod. A refresh token, an OAuth grant or a client secret copied across would
-- keep working against prod's own backend for as long as it is valid there:
-- everyone with dev database access could replay it. So every live
-- credential is cleared here. Password hashes stay, so people can still sign
-- in to dev with their own passwords — the trade-off chosen for this copy.
--
-- No CASCADE, on purpose: a new table with an FK onto one of these must be
-- decided on (scrub it too, or not), not silently emptied. Such an FK makes
-- the TRUNCATE fail, and tests/sync-scrub.test.ts fails with it in CI rather
-- than the nightly restore failing on dev.
--
-- Every name is schema-qualified because the dump this follows empties
-- search_path for the rest of the session; an unqualified table doesn't
-- resolve, and the whole restore rolls back.  The test runs it the same way.
TRUNCATE public.refresh_tokens, public.oauth_refresh_tokens,
         public.oauth_authorization_codes, public.oauth_pending_consent,
         public.login_attempts;
UPDATE public.oauth_clients SET secret_hash = NULL, revoked_at = COALESCE(revoked_at, NOW());

-- The restored copy says what it is, for sync.sh's target check: a database
-- marked anything but 'dev' is refused as a restore target whatever its
-- hostname. Prod carries no marker table, so the dump never brings one.
CREATE TABLE public.env_marker (name TEXT PRIMARY KEY);
INSERT INTO public.env_marker (name) VALUES ('dev');
-- Sealed values (lib/sealed.ts) are sealed under prod's keys, which dev
-- doesn't have — the Facebook account pool's logins under FB_POOL_KEY.
-- Blanked so dev holds neither the secrets nor blobs it can't open; the rows
-- themselves stay, so the rack still looks real. One blob left behind 500s
-- the page that reads it, so every *_enc column of every table is found here
-- rather than listed: a new one is cleared without an edit.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT cl.relname AS tbl, a.attname AS col
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND cl.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname ~ '_enc$'
  LOOP
    EXECUTE pg_catalog.format('UPDATE public.%I SET %I = NULL WHERE %I IS NOT NULL', c.tbl, c.col, c.col);
  END LOOP;
END $$;
