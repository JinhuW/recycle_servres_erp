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
#
# THIS ONLY RESTARTS A MONITOR THAT IS ALREADY RUNNING HERE. It must never start
# one. The laptop deployment this was written for has been retired — the live
# monitor is a container on the homelab VM (deploy/docker-compose.homelab.yml),
# which shares this machine's NAT IP. Loading the laptop agent would put a
# SECOND monitor on the same Facebook account from the same public IP, doubling
# that IP's request rate, which is the single pattern most likely to get the
# account checkpointed. The staleness trigger below is permanently satisfied on
# a retired host (the log stopped advancing the day it was retired), so without
# the guard the very first tick after a reboot does exactly that.
set -eu

ROOT="/Users/jinhu/Development/recycle_servers/recycle_servres_erp/trackers/facebook"
AGENT_LABEL="com.recycleservers.fbmonitor"
AGENT="$HOME/Library/LaunchAgents/${AGENT_LABEL}.plist"
LOG="$HOME/.ai-marketplace-monitor/ai-marketplace-monitor.log"
WATCHLOG="$ROOT/logs/watchdog.log"

# max_search_interval is 75 min, so the monitor can legitimately be quiet that
# long between cycles. 110 minutes leaves margin for a slow cycle without
# letting a real hang sit for hours.
STALL_MINUTES=110

note() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$WATCHLOG"; }

mkdir -p "$ROOT/logs"

# Is this host actually serving the monitor? `launchctl list` prints one line
# per loaded job; an unloaded agent is absent entirely. Absent means a human
# unloaded it (or never loaded it), and reloading it here would be this script
# overruling that decision — see the header. Silent, because this runs every ten
# minutes and on a retired host it is the normal state, not an incident.
if ! launchctl list 2>/dev/null | grep -q "[[:space:]]${AGENT_LABEL}\$"; then
    exit 0
fi

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
