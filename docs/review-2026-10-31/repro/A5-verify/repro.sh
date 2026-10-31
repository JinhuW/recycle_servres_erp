#!/bin/sh
# Applies every ERP migration (scripts/migrate.mjs) to a disposable PG18 (container review1031-A5v),
# seeds one fleet_proxies row like prod has, then runs scrub.sql exactly as
# sync.sh does (single transaction, ON_ERROR_STOP, empty search_path).
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
C=review1031-A5v
P="docker exec -i $C psql -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "DROP DATABASE IF EXISTS a5" -c "CREATE DATABASE a5"
(cd "$ROOT/apps/backend" && DATABASE_URL=postgres://postgres:review@127.0.0.1:55705/a5 node ./scripts/migrate.mjs >/dev/null 2>&1) || { echo "migrate failed"; exit 2; }
echo "migrations applied: $($P -d a5 -tA -c "SELECT count(*) FROM schema_migrations")"
$P -d a5 -c "INSERT INTO fleet_proxies (label, url_enc, host, port, timezone) VALUES ('p1','v1.a.b.c','1.2.3.4',8080,'America/Denver')"
echo "--- scrub run:"
{ echo "SELECT pg_catalog.set_config('search_path', '', false);"; cat "$ROOT"/deploy/railway-sync/scrub.sql; } \
  | docker exec -i $C psql -U postgres -d a5 --single-transaction -v ON_ERROR_STOP=1 -q; echo "scrub exit=$?"
echo "--- env_marker after (absent = rolled back):"
$P -d a5 -tA -c "SELECT to_regclass('public.env_marker')"
