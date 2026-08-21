#!/bin/sh
# Daily keyword evaluation. Mines the monitor log for evidence, has Claude turn
# it into a review, and writes a dated report. Reports only — nothing here edits
# master.toml, regenerates shards, or touches the running fleet.
#
# Run by launchd via deploy/com.recycleservers.keyword-eval.plist, or by hand:
#     scripts/eval-keywords.sh [HOURS]
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOURS="${1:-24}"
PY="$ROOT/.venv-aimm/bin/python"
REPORTS="$ROOT/reports"
STAMP="$(date +%Y-%m-%d)"
REPORT="$REPORTS/keywords-$STAMP.md"
EVIDENCE="$REPORTS/.evidence-$STAMP.md"

mkdir -p "$REPORTS"

[ -x "$PY" ] || { echo "missing interpreter $PY (needs 3.11+ for tomllib)" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "claude CLI not on PATH" >&2; exit 1; }

echo "[$(date '+%F %T')] extracting evidence (last ${HOURS}h)"
"$PY" scripts/eval-keywords.py --since "$HOURS" > "$EVIDENCE"

echo "[$(date '+%F %T')] writing $REPORT"
claude -p \
  --allowedTools Read Grep Glob \
  --append-system-prompt "$(cat "$ROOT/scripts/eval-keywords.prompt")" \
  "Here is today's evidence pack. Write the report exactly as instructed.

$(cat "$EVIDENCE")" > "$REPORT"

# Keep the raw evidence next to the report so a finding can be traced back, but
# only for the reports that still exist.
mv "$EVIDENCE" "$REPORTS/evidence-$STAMP.md"

# Prune anything older than 60 days; these accumulate one pair per day.
find "$REPORTS" -name 'keywords-*.md' -mtime +60 -delete 2>/dev/null || true
find "$REPORTS" -name 'evidence-*.md' -mtime +60 -delete 2>/dev/null || true

echo "[$(date '+%F %T')] done: $REPORT"
