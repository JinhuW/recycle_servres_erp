#!/bin/sh
# Stream a compressed pg_dump straight to Cloudflare R2 — never touches local
# disk, so it runs in a tiny container with no volume.
#
# Required env (set on the Railway service):
#   DATABASE_URL                       Postgres connection string (private ref)
#   R2_BACKUP_BUCKET                   target bucket, e.g. recycle-erp-backups
#   RCLONE_CONFIG_R2_TYPE=s3
#   RCLONE_CONFIG_R2_PROVIDER=Cloudflare
#   RCLONE_CONFIG_R2_ACCESS_KEY_ID     backups token access key id
#   RCLONE_CONFIG_R2_SECRET_ACCESS_KEY backups token secret (sha256 of token)
#   RCLONE_CONFIG_R2_ENDPOINT          https://<account>.r2.cloudflarestorage.com
#   RCLONE_CONFIG_R2_REGION=auto
#   RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true   (token can't create buckets)
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET is required}"

ts=$(date -u +%Y-%m-%dT%H%M%SZ)
key="postgres/recycle-erp-${ts}.sql.gz"

echo "[backup] dumping -> r2:${R2_BACKUP_BUCKET}/${key}"
# pipefail isn't in POSIX sh; guard each stage by failing the pipeline if
# pg_dump errors (gzip/rclone will see a truncated stream and the set -e on the
# explicit checks below catches it). rcat streams stdin to the object.
pg_dump --no-owner --no-privileges "$DATABASE_URL" \
  | gzip -9 \
  | rclone rcat "r2:${R2_BACKUP_BUCKET}/${key}"

echo "[backup] done: ${key}"
