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

# Same defaults as scripts/deploy.sh — the monitor runs in a container on the
# homelab VM, not here.
VM="${RS_MONITOR_HOST:-jinhu@10.10.10.73}"
C="${RS_MONITOR_CONTAINER:-rs-monitor}"
LIVE_LOG="$ROOT/logs/monitor-live.log"

mkdir -p "$REPORTS" "$ROOT/logs"

[ -x "$PY" ] || { echo "missing interpreter $PY (needs 3.11+ for tomllib)" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "claude CLI not on PATH" >&2; exit 1; }

# Fetch the log the live monitor is actually writing.
#
# logs/monitor.out.log is the RETIRED laptop agent's stdout. That agent is not
# loaded, deploy.sh excludes logs/ from the rsync, and nothing else writes to
# it — so it is frozen at the moment of the migration and can never advance
# again. Defaulting to it meant this job re-analysed the same dead window every
# morning and filed it under a new date, with no way to tell from the report.
echo "[$(date '+%F %T')] fetching container log from $VM"
if ssh -o BatchMode=yes -o ConnectTimeout=10 "$VM" \
        "docker logs --since ${HOURS}h $C" > "$LIVE_LOG.part" 2>/dev/null \
        && [ -s "$LIVE_LOG.part" ]; then
    mv "$LIVE_LOG.part" "$LIVE_LOG"
    LOG_ARG="logs/monitor-live.log"
else
    rm -f "$LIVE_LOG.part"
    # Do not silently fall back to a stale local file and call it today's
    # evidence. eval-keywords.py banners a stale log, but a report nobody can
    # trust is worse than no report.
    echo "error: could not read \`docker logs $C\` on $VM." >&2
    echo "       Check the VM is up and the container is running, or pass a" >&2
    echo "       log explicitly:  $PY scripts/eval-keywords.py --log <path>" >&2
    exit 1
fi

echo "[$(date '+%F %T')] extracting evidence (last ${HOURS}h)"
"$PY" scripts/eval-keywords.py --since "$HOURS" --log "$LOG_ARG" > "$EVIDENCE"

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
