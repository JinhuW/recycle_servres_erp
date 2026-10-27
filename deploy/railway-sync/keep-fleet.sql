-- Runs first in the restore transaction, before dev's public schema is
-- dropped. The fleet on dev is real: a host's token, slots holding live pool
-- accounts resealed under dev's FB_POOL_KEY, and workers that are logged in to
-- Facebook right now. Prod has none of it (or, once the fleet ships, its own),
-- so a plain copy wipes it and every worker on dev loses its slot; bringing it
-- back means new logins. The rows are set aside in sync_keep, which the DROP
-- SCHEMA public does not reach, and restore-fleet.sql puts them back once the
-- backend has migrated the fresh copy.
--
-- Kept: every fleet_* table, and for each pool account that has a slot the
-- columns dev owns (every *_enc, cookie_uid, cookie_at, status, note, and the
-- holder: a worker's token is only good while the account names it as holder).
CREATE SCHEMA sync_keep;
CREATE TABLE sync_keep._migrations AS SELECT filename FROM public.schema_migrations;

DO $$
DECLARE t RECORD;
BEGIN
  -- A column typed by something in public (an enum, a domain) would be dropped
  -- from the copy by the CASCADE, silently. Refuse here instead, while dev is
  -- still untouched.
  PERFORM 1
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
  JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = ty.typnamespace
  WHERE n.nspname = 'public' AND cl.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    AND (cl.relname LIKE 'fleet\_%' OR cl.relname = 'fb_pool_accounts')
    AND tn.nspname = 'public';
  IF FOUND THEN
    RAISE EXCEPTION 'keep-fleet: a fleet or pool column has a type defined in public; teach keep-fleet.sql to keep it';
  END IF;

  FOR t IN
    SELECT cl.relname FROM pg_catalog.pg_class cl
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
    WHERE n.nspname = 'public' AND cl.relkind IN ('r', 'p') AND cl.relname LIKE 'fleet\_%'
  LOOP
    EXECUTE pg_catalog.format('CREATE TABLE sync_keep.%I AS TABLE public.%I', t.relname, t.relname);
  END LOOP;

  IF pg_catalog.to_regclass('public.fleet_slots') IS NOT NULL THEN
    CREATE TABLE sync_keep._pool AS
      SELECT * FROM public.fb_pool_accounts WHERE no IN (SELECT account_no FROM public.fleet_slots);
  END IF;
END $$;
