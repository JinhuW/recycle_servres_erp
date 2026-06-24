#!/bin/sh
# Restore a Cloudflare R2 backup INTO the Railway Postgres. One-shot, run by
# Railway as a manual one-off service in the target environment. DESTRUCTIVE:
# objects in the target are dropped and recreated from the dump.
#
# The backups are pg_dump CUSTOM format (-Fc), gzipped, named
#   recycle_erp_<UTC-timestamp>.dump.gz   (flat in the bucket root)
# so restore goes through pg_restore, not psql.
#
# Required env (set on the Railway restore service):
#   DATABASE_URL                       target Postgres (read/write, clobbered).
#                                      Reference ${{Postgres.DATABASE_URL}} so it
#                                      resolves to the private network host.
#   R2_BACKUP_BUCKET                   source bucket, e.g. recycle-db-backup
#   RCLONE_CONFIG_R2_TYPE=s3
#   RCLONE_CONFIG_R2_PROVIDER=Cloudflare
#   RCLONE_CONFIG_R2_ACCESS_KEY_ID     backups token access key id
#   RCLONE_CONFIG_R2_SECRET_ACCESS_KEY backups token secret (sha256 of token)
#   RCLONE_CONFIG_R2_ENDPOINT          https://<account>.r2.cloudflarestorage.com
#   RCLONE_CONFIG_R2_REGION=auto
#   RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true   (token can't create buckets)
# Optional env:
#   BACKUP_KEY            restore this exact object key instead of auto-picking
#                         the newest, e.g. recycle_erp_20260622T020001Z.dump.gz
#   EXPECTED_DB_HOST      assert the target host:port matches this exactly. A
#                         misconfigured DATABASE_URL then fails closed instead of
#                         clobbering the wrong database.
set -eu
# pipefail so a failed rclone/gunzip fails the pipeline (alpine /bin/sh = ash).
set -o pipefail

# rclone is configured entirely via RCLONE_CONFIG_R2_* env vars, so it has no
# config file and prints a harmless "config not found" NOTICE on every call.
# Drop its log level to ERROR so only real problems surface.
export RCLONE_LOG_LEVEL=ERROR

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET is required}"

# Host-only echo (no credentials) for the log trail.
db_host=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[^@]*@##; s#/.*$##')
echo "[restore] $(date -u +%Y-%m-%dT%H:%M:%SZ)  target=${db_host}  bucket=${R2_BACKUP_BUCKET}"

# Safety rail: when EXPECTED_DB_HOST is set, the target host must match it
# exactly. Turns "trust the env var" into "assert the env var" so no future
# credential edit can silently redirect this destructive restore.
if [ -n "${EXPECTED_DB_HOST:-}" ] && [ "$db_host" != "$EXPECTED_DB_HOST" ]; then
  echo "[restore] REFUSING: target host (${db_host}) != EXPECTED_DB_HOST (${EXPECTED_DB_HOST})" >&2
  exit 1
fi

# Pick the object to restore. Keys are recycle_erp_<UTC-timestamp>.dump.gz; the
# timestamp is zero-padded and lexically sortable, so `sort | tail -1` is newest.
if [ -n "${BACKUP_KEY:-}" ]; then
  key="$BACKUP_KEY"
  echo "[restore] using pinned BACKUP_KEY=${key}"
else
  key=$(rclone lsf --files-only "r2:${R2_BACKUP_BUCKET}/" \
    | grep -E '^recycle_erp_.*\.dump\.gz$' | sort | tail -n 1)
  if [ -z "$key" ]; then
    echo "[restore] REFUSING: no recycle_erp_*.dump.gz objects in ${R2_BACKUP_BUCKET}" >&2
    exit 1
  fi
  echo "[restore] latest backup -> ${key}"
fi

# Download + verify the dump to disk BEFORE touching the database. Proving the
# archive is complete and a real pg_dump up front means the destructive restore
# only ever runs against a known-good file.
gz=/tmp/restore.dump.gz
dump=/tmp/restore.dump
echo "[restore] downloading r2:${R2_BACKUP_BUCKET}/${key}"
rclone copyto "r2:${R2_BACKUP_BUCKET}/${key}" "$gz"
gunzip -t "$gz"
gunzip -f "$gz"                       # -> $dump

size=$(wc -c < "$dump")
if [ "$size" -lt 512 ]; then
  echo "[restore] REFUSING: dump is only ${size} bytes — looks empty/truncated" >&2
  exit 1
fi
# Custom-format pg_dump archives start with the magic bytes "PGDMP".
if [ "$(head -c 5 "$dump")" != "PGDMP" ]; then
  echo "[restore] REFUSING: not a pg_dump custom-format archive (no PGDMP magic)" >&2
  exit 1
fi
# A valid archive must list a TOC; this also catches a version mismatch early.
pg_restore --list "$dump" >/dev/null
echo "[restore] verified ${size}-byte PGDMP archive"

# Restore in ONE transaction with --clean --if-exists: each object is dropped
# (IF EXISTS, so harmless on an empty target) then recreated, all inside a
# single transaction. Any failure rolls the whole thing back and leaves the
# target untouched rather than half-restored. --no-owner/--no-privileges remap
# everything to the connecting role (Railway's postgres). No --create: objects
# land in the connected `railway` database, not a recreated recycle_erp DB.
echo "[restore] pg_restore -> ${db_host}"
pg_restore --no-owner --no-privileges --clean --if-exists --single-transaction \
  --dbname "$DATABASE_URL" "$dump"

# Self-check: print a few counts so the log proves data actually landed. Best
# effort — a missing table here shouldn't fail an otherwise-good restore.
echo "[restore] post-restore summary:"
psql "$DATABASE_URL" -At -F'=' <<'CHECK' 2>&1 | sed 's/^/[restore]   /' || true
select 'tables', count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';
select 'users', count(*) from users;
select 'orders', count(*) from orders;
select 'sell_orders', count(*) from sell_orders;
select 'newest_order', max(created_at) from orders;
CHECK

echo "[restore] done $(date -u +%Y-%m-%dT%H:%M:%SZ)"
