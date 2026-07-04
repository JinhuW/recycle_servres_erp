#!/usr/bin/env bash
# backup.sh — dump the Recycle ERP database to a timestamped custom-format file.
#
# Two modes:
#   Host mode (default) — needs pg_dump on the host and a reachable DATABASE_URL:
#     DATABASE_URL=postgres://... bash backup.sh [--out <dir>] [--keep <n>]
#   Container mode — dumps through `docker exec` using the Postgres container's
#   own client over its local socket. No host pg_dump and no published port
#   needed (prod doesn't publish 5432):
#     BACKUP_PG_CONTAINER=recycle_pg bash backup.sh [--out <dir>] [--keep <n>]
#
# --keep <n>  retain only the newest <n> dumps in <dir>, deleting older ones
#             (0 = keep everything, the default).
# Output directory defaults to ./backups/ relative to where the script is run.
#
# Offsite copy to Cloudflare R2 — set BACKUP_R2_BUCKET (e.g. recycle-back) to
# also upload each dump via rclone. R2 credentials (R2_S3_ENDPOINT,
# R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) are read from the environment, or
# loaded from the repo-root .env when absent (so they need not sit in crontab).
# --keep is mirrored to the bucket: older dumps there are pruned too.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

OUT_DIR="./backups"
KEEP="${BACKUP_KEEP:-0}"
CONTAINER="${BACKUP_PG_CONTAINER:-}"
R2_BUCKET_DST="${BACKUP_R2_BUCKET:-}"
# In-container connection target (matches docker-compose.yml's postgres env).
PG_USER="${BACKUP_PG_USER:-recycle}"
PG_DB="${BACKUP_PG_DB:-recycle_erp}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_DIR="$2"
      shift 2
      ;;
    --keep)
      KEEP="$2"
      shift 2
      ;;
    --container)
      CONTAINER="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$OUT_DIR"

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DUMP_FILE="$OUT_DIR/recycle_erp_${TIMESTAMP}.dump.gz"

# Dump to an intermediate custom-format file, then compress it — rather than
# streaming `pg_dump | gzip` straight to disk. Two reasons:
#   1. A bare redirect makes pg_dump's own exit status authoritative under
#      `set -e`. In `pg_dump | gzip`, gzip still exits 0 after compressing
#      partial/empty input, which can mask a pg_dump failure (e.g. a client
#      that is older than the server and refuses to dump it).
#   2. The integrity check below reads the archive from a SEEKABLE FILE. It must
#      never be `... | pg_restore --list`: --list reads only the archive's table
#      of contents and exits early, so the upstream process dies of SIGPIPE
#      (exit 141) and `set -o pipefail` then reports a false "corrupt" verdict
#      on a perfectly good dump.
RAW_DUMP="$(mktemp "${TMPDIR:-/tmp}/recycle_erp_${TIMESTAMP}.XXXXXX")"
trap 'rm -f "$RAW_DUMP"' EXIT

echo "Dumping database to ${DUMP_FILE} ..."

if [[ -n "$CONTAINER" ]]; then
  # No -t: a TTY would corrupt the binary custom-format stream.
  docker exec "$CONTAINER" pg_dump \
    --format=custom \
    --no-owner \
    --no-privileges \
    -U "$PG_USER" \
    "$PG_DB" \
    > "$RAW_DUMP"
else
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "ERROR: DATABASE_URL is not set (and no --container/BACKUP_PG_CONTAINER given)." >&2
    exit 1
  fi
  pg_dump \
    --format=custom \
    --no-owner \
    --no-privileges \
    "$DATABASE_URL" \
    > "$RAW_DUMP"
fi

# Integrity gate: the archive must list its table of contents, or we abort
# before gzipping/uploading a corrupt dump. Read from the file (seekable), never
# a pipe. Container mode has no host pg_restore, so verify with the container's
# own client against a copy placed inside the container.
echo "Verifying dump integrity ..."
if [[ -n "$CONTAINER" ]]; then
  IN_CONTAINER_DUMP="/tmp/recycle_erp_verify_${TIMESTAMP}.dump"
  docker cp "$RAW_DUMP" "${CONTAINER}:${IN_CONTAINER_DUMP}"
  if ! docker exec "$CONTAINER" pg_restore --list "$IN_CONTAINER_DUMP" >/dev/null 2>&1; then
    docker exec "$CONTAINER" rm -f "$IN_CONTAINER_DUMP" || true
    echo "ERROR: dump failed integrity check (pg_restore --list); not uploading." >&2
    exit 1
  fi
  docker exec "$CONTAINER" rm -f "$IN_CONTAINER_DUMP" || true
else
  if ! pg_restore --list "$RAW_DUMP" >/dev/null 2>&1; then
    echo "ERROR: dump failed integrity check (pg_restore --list); not uploading." >&2
    exit 1
  fi
fi

# Compress into place. -n omits the timestamp/name header for reproducibility.
gzip -n -c "$RAW_DUMP" > "$DUMP_FILE"

SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
echo "Backup complete: ${DUMP_FILE} (${SIZE})"

# Offsite copy to R2 (optional).
if [[ -n "$R2_BUCKET_DST" ]]; then
  # Load R2 credentials from the repo-root .env if not already in the env.
  if [[ -z "${R2_ACCESS_KEY_ID:-}" && -f "$REPO_ROOT/.env" ]]; then
    set -a
    eval "$(grep -E '^R2_(S3_ENDPOINT|ACCESS_KEY_ID|SECRET_ACCESS_KEY)=' "$REPO_ROOT/.env")"
    set +a
  fi
  : "${R2_S3_ENDPOINT:?R2_S3_ENDPOINT not set}"
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID not set}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY not set}"

  # Configure the rclone S3 remote entirely from env — no rclone.conf needed.
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="$R2_S3_ENDPOINT"
  export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

  echo "Uploading to R2:${R2_BUCKET_DST} ..."
  # --s3-no-head / --s3-disable-checksum avoid ops R2 returns 501 for.
  rclone copy "$DUMP_FILE" "R2:${R2_BUCKET_DST}/" --s3-no-head --s3-disable-checksum -q
  echo "Offsite copy complete."

  # Mirror --keep to the bucket: timestamped names sort chronologically.
  if [[ "$KEEP" -gt 0 ]]; then
    rclone lsf "R2:${R2_BUCKET_DST}/" 2>/dev/null \
      | grep -E '^recycle_erp_.*\.dump\.gz$' \
      | sort \
      | head -n "-$KEEP" \
      | while IFS= read -r old; do
          echo "Pruning old R2 backup: $old"
          rclone deletefile "R2:${R2_BUCKET_DST}/${old}" -q
        done
  fi
fi

# Rotation: keep only the newest $KEEP dumps in $OUT_DIR.
if [[ "$KEEP" -gt 0 ]]; then
  ls -1t "$OUT_DIR"/recycle_erp_*.dump.gz 2>/dev/null \
    | tail -n +"$((KEEP + 1))" \
    | while IFS= read -r old; do
        echo "Pruning old backup: $old"
        rm -f -- "$old"
      done
fi
