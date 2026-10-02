#!/usr/bin/env bash
# backup.sh — dump the Railway ERP Postgres to Cloudflare R2.
#
# Designed to run as a Railway *cron service*: it performs one dump, uploads it
# offsite to R2, prunes old dumps, and exits. The container is ephemeral, so
# there is no on-disk rotation to worry about — only the R2 copy is retained.
#
# It runs inside a `postgres:18` image, so `pg_dump`/`pg_restore` here are v18
# and can dump the Railway server (PostgreSQL 18.x). A v16/v17 client cannot —
# that is the whole reason this image is pinned to 18.
#
# Configuration (all via environment):
#   DATABASE_URL            Postgres connection string. On Railway this is a
#                           reference variable -> ${{Postgres.DATABASE_URL}}
#                           (private network: postgres.railway.internal).
#   R2_S3_ENDPOINT          Cloudflare R2 S3 endpoint (https://<acct>.r2...).
#   R2_ACCESS_KEY_ID        R2 access key id.
#   R2_SECRET_ACCESS_KEY    R2 secret access key.
#   BACKUP_R2_BUCKET        Destination bucket   (default: recycle-db-backup).
#   BACKUP_R2_PREFIX        Key prefix / folder  (default: railway-erp).
#   BACKUP_KEEP             Newest N dumps to keep in R2 (default: 30, 0 = all).
#   BACKUP_NAME_PREFIX      Dump filename prefix (default: recycle_erp_railway).
#
# Non-secret defaults are baked into the Dockerfile as ENV; secrets and
# DATABASE_URL are injected as Railway variables.

set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL not set}"
R2_S3_ENDPOINT="${R2_S3_ENDPOINT:?R2_S3_ENDPOINT not set}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID not set}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY not set}"
R2_BUCKET="${BACKUP_R2_BUCKET:-recycle-db-backup}"
R2_PREFIX="${BACKUP_R2_PREFIX:-railway-erp}"
KEEP="${BACKUP_KEEP:-30}"
NAME_PREFIX="${BACKUP_NAME_PREFIX:-recycle_erp_railway}"

# Trim any trailing slash so "bucket/prefix/" composes cleanly.
R2_PREFIX="${R2_PREFIX%/}"
R2_DST="${R2_BUCKET}/${R2_PREFIX}"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
DUMP_RAW="/tmp/${NAME_PREFIX}_${TIMESTAMP}.dump"
DUMP_FILE="${DUMP_RAW}.gz"

echo "[$(date -u +%FT%TZ)] Dumping Railway Postgres -> ${DUMP_FILE} ..."

# --format=custom keeps the dump compact and lets pg_restore be selective.
# Write to a plain (seekable) file, NOT through a `| gzip` pipe: a bare
# redirect lets `set -e` abort on a pg_dump failure directly, and the file can
# then be integrity-checked without a pipe (see below).
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  "$DATABASE_URL" \
  > "$DUMP_RAW"

# Integrity gate: a custom-format dump must list its table of contents. Read
# the archive from the FILE, never `gunzip -c | pg_restore --list`: pg_restore
# reads only the TOC and exits early, so gunzip dies of SIGPIPE (exit 141) and
# `set -o pipefail` would report a false "corrupt" verdict on a perfectly good
# dump. Checking the file directly avoids that pipe entirely.
TOC="$(pg_restore --list "$DUMP_RAW" 2>/dev/null)" || {
  echo "ERROR: dump failed integrity check (pg_restore --list); not uploading." >&2
  exit 1
}
# A readable TOC is not yet a useful dump: an empty or half-migrated database
# lists fine too. The tables the business runs on must carry data entries.
for table in orders order_lines sell_orders users; do
  if ! grep -qE "TABLE DATA public ${table}( |$)" <<<"$TOC"; then
    echo "ERROR: dump has no data for public.${table}; not uploading." >&2
    exit 1
  fi
done

# Compress for storage/transfer. Custom format is already zlib-compressed, so
# this is a modest extra squeeze but keeps the .dump.gz naming consistent.
# -f to overwrite any stale temp.
gzip -n -f "$DUMP_RAW"

SIZE="$(du -sh "$DUMP_FILE" | cut -f1)"
echo "[$(date -u +%FT%TZ)] Dump OK (${SIZE}). Uploading to R2:${R2_DST}/ ..."

# Configure the rclone S3 remote entirely from env — no rclone.conf on disk.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$R2_S3_ENDPOINT"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

# --s3-no-head / --s3-disable-checksum avoid ops R2 returns 501 for.
rclone copy "$DUMP_FILE" "R2:${R2_DST}/" --s3-no-head --s3-disable-checksum -q
echo "[$(date -u +%FT%TZ)] Offsite copy complete."

# Prune: keep only the newest $KEEP dumps in R2. Timestamped names sort
# chronologically, so lexical sort == chronological order.
# The listing is taken on its own line so a failed `lsf` aborts the run
# (set -e) instead of reading as "nothing to prune"; `|| true` then keeps a
# no-match grep from tripping pipefail after a successful upload.
if [[ "$KEEP" -gt 0 ]]; then
  LISTING="$(rclone lsf "R2:${R2_DST}/")"
  { grep -E "^${NAME_PREFIX}_.*\.dump\.gz$" <<<"$LISTING" || true; } \
    | sort \
    | head -n "-${KEEP}" \
    | while IFS= read -r old; do
        echo "Pruning old R2 backup: $old"
        rclone deletefile "R2:${R2_DST}/${old}" -q
      done
fi

echo "[$(date -u +%FT%TZ)] Backup finished."
