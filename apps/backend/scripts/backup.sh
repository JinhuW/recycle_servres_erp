#!/usr/bin/env bash
# backup.sh — dump the Recycle ERP database to a timestamped custom-format file.
#
# Usage:
#   DATABASE_URL=postgres://... bash backup.sh [--out <dir>]
#
# The DATABASE_URL environment variable must be set (same format as .env).
# Output directory defaults to ./backups/ relative to where the script is run.

set -euo pipefail

OUT_DIR="./backups"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DUMP_FILE="$OUT_DIR/recycle_erp_${TIMESTAMP}.dump.gz"

echo "Dumping database to ${DUMP_FILE} ..."

pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  "$DATABASE_URL" \
  | gzip > "$DUMP_FILE"

SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
echo "Backup complete: ${DUMP_FILE} (${SIZE})"
