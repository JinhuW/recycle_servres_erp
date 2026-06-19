#!/bin/sh
# Copy the PROD database into the DEV database. ONE-DIRECTIONAL: prod -> dev.
# DEV is overwritten to become an exact mirror of prod. Never writes to prod.
#
# Required env (set on the Railway DEV sync service):
#   PROD_DATABASE_URL   source — prod Postgres (read). Reached via its public
#                       TCP proxy, since cross-environment private DNS isn't
#                       available; use a READ-capable role if you have one.
#   DEV_DATABASE_URL    target — dev Postgres (read/write, gets clobbered).
set -eu

: "${PROD_DATABASE_URL:?PROD_DATABASE_URL is required}"
: "${DEV_DATABASE_URL:?DEV_DATABASE_URL is required}"

# Safety rail: refuse to run if source and target are the same database, so a
# misconfiguration can never make the job write onto prod.
if [ "$PROD_DATABASE_URL" = "$DEV_DATABASE_URL" ]; then
  echo "[sync] REFUSING: PROD_DATABASE_URL and DEV_DATABASE_URL are identical" >&2
  exit 1
fi

# Host-only echo (no credentials) for the log trail.
prod_host=$(printf '%s' "$PROD_DATABASE_URL" | sed -E 's#^[^@]*@##; s#/.*$##')
dev_host=$(printf '%s' "$DEV_DATABASE_URL"  | sed -E 's#^[^@]*@##; s#/.*$##')
echo "[sync] $(date -u +%Y-%m-%dT%H:%M:%SZ)  prod(${prod_host}) -> dev(${dev_host})"

# --clean --if-exists: drop each object before recreating, so dev ends up an
# exact copy (schema + data + the migration ledger). --single-transaction +
# ON_ERROR_STOP on the restore side means a failure leaves dev unchanged rather
# than half-synced.
pg_dump --no-owner --no-privileges --clean --if-exists "$PROD_DATABASE_URL" \
  | psql --single-transaction --set ON_ERROR_STOP=1 "$DEV_DATABASE_URL" >/dev/null

echo "[sync] done $(date -u +%Y-%m-%dT%H:%M:%SZ)"
