#!/bin/sh
# Repro A11-04: scrub.sql's generic *_enc nulling vs fleet_proxies.url_enc NOT NULL (0213).
set -u
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
docker rm -f review1031-a11v >/dev/null 2>&1
docker run -d --name review1031-a11v -e POSTGRES_PASSWORD=review -p 127.0.0.1:55711:5432 postgres:18 >/dev/null
until docker exec review1031-a11v pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2
docker exec -i review1031-a11v psql -U postgres -v ON_ERROR_STOP=1 -q <<SQL
$(sed -n "/CREATE TABLE fleet_proxies/,/);/p" "$REPO/apps/backend/migrations/0213_fleet_proxies.sql" | sed -E "s/ REFERENCES [a-z_]+ ?(\([a-z_]+\))?( ON DELETE [A-Z ]+)?//")
INSERT INTO fleet_proxies (label, url_enc, host, port, timezone) VALUES ('NJ1','v1.a.b.c','isp.example',10018,'America/New_York');
SQL
echo "--- scrub DO block from deploy/railway-sync/scrub.sql:"
sed -n '/^DO \$\$/,/^END \$\$;/p' "$REPO/deploy/railway-sync/scrub.sql" | docker exec -i review1031-a11v psql -U postgres -v ON_ERROR_STOP=1 -q; echo "psql rc=$?"
docker rm -f review1031-a11v >/dev/null
