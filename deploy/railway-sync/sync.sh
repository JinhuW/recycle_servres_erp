#!/bin/sh
# Copy the PROD database into the DEV database. ONE-DIRECTIONAL: prod -> dev.
# DEV is overwritten to become a mirror of prod, except its Facebook fleet
# (keep-fleet.sql, restore-fleet.sql). Never writes to prod.
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
# Checked up front so a missing redeploy credential aborts before the
# destructive restore, not after it.
: "${RAILWAY_PROJECT_TOKEN:?RAILWAY_PROJECT_TOKEN is required}"
: "${BACKEND_SERVICE_ID:?BACKEND_SERVICE_ID is required}"
: "${RAILWAY_ENVIRONMENT_ID:?RAILWAY_ENVIRONMENT_ID is required}"

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

# The pin is required: the target host must match EXPECTED_DEV_DB_HOST exactly
# (host:port). "Trust the env var" becomes "assert the env var", so no future
# credential edit can silently redirect the restore. It was optional, and the
# two string checks above pass the same database reached through its public
# proxy and its private hostname.
: "${EXPECTED_DEV_DB_HOST:?EXPECTED_DEV_DB_HOST is required: the dev database host:port this job may restore onto}"
if [ "$dev_host" != "$EXPECTED_DEV_DB_HOST" ]; then
  echo "[sync] REFUSING: target host (${dev_host}) != EXPECTED_DEV_DB_HOST (${EXPECTED_DEV_DB_HOST})" >&2
  exit 1
fi

# And the database says what it is: scrub.sql leaves a marker row in every
# restored dev, and a target that carries a marker naming anything else — or
# none, once it has one — is not the dev database whatever its hostname. A
# target with no marker table at all is a dev that predates the marker; the
# first restore gives it one.
# Two statements, not one CASE: Postgres resolves every relation a query names
# before it runs, so naming a missing env_marker in the untaken branch still
# errors, and set -e then aborts the sync on exactly the dev it should heal.
marker=absent
if [ "$(psql -tA "$DEV_DATABASE_URL" -c "SELECT to_regclass('public.env_marker') IS NOT NULL")" = "t" ]; then
  marker=$(psql -tA "$DEV_DATABASE_URL" -c "SELECT COALESCE((SELECT name FROM public.env_marker LIMIT 1), 'none')")
fi
if [ "$marker" != "absent" ] && [ "$marker" != "dev" ]; then
  echo "[sync] REFUSING: target database is marked '${marker}', not 'dev'" >&2
  exit 1
fi

# A sync_keep schema left behind means an earlier run set dev's fleet aside and
# never put it back (restore-fleet.sql). Copying over it now would replace it
# with an empty fleet, so stop and leave dev as it is for a person to decide:
# run restore-fleet.sql against dev, or DROP SCHEMA sync_keep CASCADE to let
# the fleet go.
if [ "$(psql -tA "$DEV_DATABASE_URL" -c "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'sync_keep')")" = "t" ]; then
  echo "[sync] REFUSING: dev still holds sync_keep from a run whose fleet restore did not finish" >&2
  exit 1
fi

# Reset dev's schema wholesale instead of pg_dump --clean: --clean orders its
# DROPs by PROD's dependency graph, so any dev-only object (e.g. an FK from a
# migration not yet shipped to prod) blocks a DROP and aborts the sync — this
# broke nightly when 0074's sell_orders FK existed on dev only.
#
# The dump lands in a temp file FIRST, and only a fully successful pg_dump
# reaches the restore. Never stream pg_dump straight into the psql that also
# carries the DROP SCHEMA preamble: if pg_dump dies early (version mismatch,
# revoked grants, network), psql sees preamble-then-EOF — a complete, valid
# script — and COMMITS an empty dev. That exact wipe happened on 2026-07-16.
# No suffix after the X's — busybox mktemp (alpine) requires the template to
# end in XXXXXX.
dump="$(mktemp /tmp/prod-dump.XXXXXX)"
trap 'rm -f "$dump"' EXIT
pg_dump --no-owner --no-privileges "$PROD_DATABASE_URL" > "$dump"

# Fleet keep + preamble + dump + scrub run in ONE transaction, so a
# mid-restore failure still rolls back to an unchanged dev rather than an empty
# one, and no moment exists where dev holds prod's live tokens. pgcrypto lives
# in public and is dropped by the CASCADE; the dump's CREATE EXTENSION
# restores it. keep-fleet.sql sets dev's fleet aside in sync_keep first.
{
  cat /usr/local/share/sync/keep-fleet.sql
  echo 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  cat "$dump"
  cat /usr/local/share/sync/scrub.sql
} | psql --single-transaction --set ON_ERROR_STOP=1 "$DEV_DATABASE_URL" >/dev/null

# The restore just replaced dev's schema with prod's, which erases any dev-only
# migrations and leaves the running backend holding pooled connections and
# cached plans against dropped objects — every query 500s until it restarts
# (broke /api/sell-orders nightly while 0074 existed only on dev). Redeploy the
# backend so its boot sequence re-runs migrate.mjs on the fresh schema.
# GraphQL returns HTTP 200 even on failure, so grep the body for "errors".
resp=$(curl -fsS -X POST https://backboard.railway.com/graphql/v2 \
  -H "Project-Access-Token: $RAILWAY_PROJECT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation { serviceInstanceRedeploy(serviceId: \\\"$BACKEND_SERVICE_ID\\\", environmentId: \\\"$RAILWAY_ENVIRONMENT_ID\\\") }\"}")
case "$resp" in
  *'"errors"'*)
    echo "[sync] backend redeploy FAILED: $resp" >&2
    exit 1
    ;;
esac
echo "[sync] backend redeploy triggered"

# The fleet tables come from migrations prod has not run (or newer than its
# own), so they exist again only once the redeployed backend has migrated the
# copy: wait until every migration dev had before is applied again, then put
# the fleet back. A failed query here (the backend's migrate holding a lock, a
# blip) is just another wait.
wait_s=${FLEET_RESTORE_WAIT_SECONDS:-1200}
waited=0
while :; do
  missing=$(psql -tA "$DEV_DATABASE_URL" -c "SELECT count(*) FROM sync_keep._migrations k WHERE NOT EXISTS (SELECT 1 FROM public.schema_migrations m WHERE m.filename = k.filename)" 2>/dev/null || echo unknown)
  [ "$missing" = "0" ] && break
  if [ "$waited" -ge "$wait_s" ]; then
    echo "[sync] fleet NOT restored: ${missing} migrations still missing after ${wait_s}s; sync_keep left on dev, run restore-fleet.sql by hand" >&2
    exit 1
  fi
  sleep 10
  waited=$((waited + 10))
done
psql --single-transaction --set ON_ERROR_STOP=1 -f /usr/local/share/sync/restore-fleet.sql "$DEV_DATABASE_URL" >/dev/null
echo "[sync] fleet restored after ${waited}s"

echo "[sync] done $(date -u +%Y-%m-%dT%H:%M:%SZ)"
