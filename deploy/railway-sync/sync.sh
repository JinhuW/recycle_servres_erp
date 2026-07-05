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
# pipefail so a pg_dump failure fails the whole pipeline (alpine /bin/sh = ash
# supports it). Without this, the pipeline's status is psql's — which exits 0 on
# empty input, so a failed dump would still print "[sync] done". With set -e the
# script now aborts before the success line.
set -o pipefail

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

# Safety rail #2: the target (DEV) must never resolve to the prod host. The
# URL-equality check above misses a transposed config where the two URLs differ
# but DEV_DATABASE_URL was pointed at prod anyway (e.g. someone pasted the prod
# public TCP proxy). A host match here means the destructive --clean restore
# would land on prod — refuse.
if [ "$prod_host" = "$dev_host" ]; then
  echo "[sync] REFUSING: target host (${dev_host}) equals the prod source host" >&2
  exit 1
fi

# Optional pin: when EXPECTED_DEV_DB_HOST is set on the service, the target host
# must match it exactly (host:port). Turns "trust the env var" into "assert the
# env var", so no future credential edit can silently redirect the restore.
if [ -n "${EXPECTED_DEV_DB_HOST:-}" ] && [ "$dev_host" != "$EXPECTED_DEV_DB_HOST" ]; then
  echo "[sync] REFUSING: target host (${dev_host}) != EXPECTED_DEV_DB_HOST (${EXPECTED_DEV_DB_HOST})" >&2
  exit 1
fi

# --clean --if-exists: drop each object before recreating, so dev ends up an
# exact copy (schema + data + the migration ledger). --single-transaction +
# ON_ERROR_STOP on the restore side means a failure leaves dev unchanged rather
# than half-synced.
pg_dump --no-owner --no-privileges --clean --if-exists "$PROD_DATABASE_URL" \
  | psql --single-transaction --set ON_ERROR_STOP=1 "$DEV_DATABASE_URL" >/dev/null

echo "[sync] done $(date -u +%Y-%m-%dT%H:%M:%SZ)"
