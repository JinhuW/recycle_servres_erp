#!/bin/sh
# Daily live check that the fleet's search URLs still return what they should.
#
# Runs the monitor's own URL, through its own parser and its own title gate,
# and writes reports/search-probe-<date>.md — the artefact that answers "the
# URL looks fine in my browser, so why is the log full of laptops?".
#
# Read-only with respect to the fleet: it opens a browser, reads Marketplace,
# and writes a report. It never edits master.toml or restarts a worker.
#
# Run by launchd via deploy/com.recycleservers.search-probe.plist, or by hand:
#     scripts/probe-search-url.sh [extra probe-search-url.py args]
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The config reads OPENROUTER_API_KEY and friends from the environment.
set -a
. "$ROOT/configs/secrets.env"
set +a

PY="$ROOT/.venv-aimm/bin/python"
REPORTS="$ROOT/reports"
STAMP="$(date +%Y-%m-%d)"
REPORT="$REPORTS/search-probe-$STAMP.md"

mkdir -p "$REPORTS"
[ -x "$PY" ] || { echo "missing interpreter $PY" >&2; exit 1; }

echo "[$(date '+%F %T')] probing search URLs"
# One phrase per item by default. Each probe scrolls a full result page, so the
# phrase count is what this costs in Facebook traffic — keep it small.
"$PY" scripts/probe-search-url.py --out "$REPORT" "$@"

# One report a day; same 60-day window the keyword review uses.
find "$REPORTS" -name 'search-probe-*.md' -mtime +60 -delete 2>/dev/null || true

echo "[$(date '+%F %T')] done: $REPORT"
