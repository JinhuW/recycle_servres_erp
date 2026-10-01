-- 0042 created this role with a password committed to the repo, and roles are
-- cluster-wide: on any cluster reachable from outside (prod has a public TCP
-- proxy) anyone could log in and read every session's query text. The role and
-- its pg_monitor grant stay so an exporter can still be pointed at it, but
-- logging in now takes a deliberate, out-of-band
--   ALTER ROLE metrics LOGIN PASSWORD '<secret>';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrics') THEN
    ALTER ROLE metrics NOLOGIN PASSWORD NULL;
  END IF;
END $$;
