#!/bin/sh
# Restart the monitor when it has stopped making progress.
#
# launchd's KeepAlive only catches a process that EXITS. The failure this guards
# against is a process that HANGS: when the Mac sleeps, the pipe to Playwright's
# Node driver breaks (EPIPE), the driver dies, and the Python process blocks
# forever waiting on a reply that will never come. launchd still sees a healthy
# PID, so nothing restarts it — the monitor sat dead for nine hours overnight
# before this existed.
#
# Progress is measured by the log's mtime: the monitor writes constantly while
# scanning, and its longest legitimate quiet stretch is one search interval.
set -eu

ROOT="/Users/jinhu/Projects/recycle_servers/facebook_tracker"
AGENT="$HOME/Library/LaunchAgents/com.recycleservers.fbmonitor.plist"
LOG="$HOME/.ai-marketplace-monitor/ai-marketplace-monitor.log"
WATCHLOG="$ROOT/logs/watchdog.log"

# max_search_interval is 75 min, so the monitor can legitimately be quiet that
# long between cycles. 110 minutes leaves margin for a slow cycle without
# letting a real hang sit for hours.
STALL_MINUTES=110

note() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$WATCHLOG"; }

mkdir -p "$ROOT/logs"

[ -f "$LOG" ] || { note "no log yet at $LOG; nothing to judge"; exit 0; }

# -mmin +N is "modified more than N minutes ago".
if [ -z "$(find "$LOG" -mmin +$STALL_MINUTES 2>/dev/null)" ]; then
    exit 0   # progressing; say nothing, this runs every few minutes
fi

note "log stale >${STALL_MINUTES}m — restarting the monitor"

launchctl unload "$AGENT" 2>/dev/null || true
sleep 2
# The hung Python process ignores the unload, and its browser children outlive
# it; both have to go or the restart inherits the wreckage.
pkill -f "ai_marketplace_monitor|/aimm " 2>/dev/null || true
pkill -f "chrome-headless-shell" 2>/dev/null || true
sleep 2
launchctl load "$AGENT" 2>/dev/null || true

note "restarted"
