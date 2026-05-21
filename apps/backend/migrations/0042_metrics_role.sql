-- Read-only role for the postgres-exporter sidecar.
-- pg_monitor grants pg_read_all_settings + pg_read_all_stats +
-- pg_stat_scan_tables. No SELECT on user tables, no DML, no DDL.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrics') THEN
    CREATE ROLE metrics LOGIN PASSWORD 'metrics';
  END IF;
END $$;

GRANT pg_monitor TO metrics;
