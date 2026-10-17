#!/bin/sh
# Liveness for rs-monitor, which can stall without dying.
#
# The failure this exists for: on 2026-08-21 a page.goto() on a Marketplace item
# page never returned, and the monitor sat on it for ten hours. The page had
# rendered fine — VNC showed the listing, logged in, no captcha — but Facebook's
# SPA never fires the "load" event goto() waits for, and the call was made with
# timeout=0. supervisor saw a RUNNING program, the process never exited, so
# `restart: unless-stopped` had nothing to react to, and alerts stopped with
# nothing logged after the "Navigating to" line.
#
# marketplace.py no longer waits forever, so that specific stall is fixed. This
# is the backstop for the next one. The compose header argues that a server
# which never sleeps removes the need for a watchdog: true of the sleeping-
# laptop hang it was written about, and this box had been up 44 days.
#
# The signal is the app log's mtime, which advances on every DEBUG line a sweep
# writes. Over a healthy 6h45m window the largest gap between writes was 69s.
# The only legitimate long silence is monitor.py's between-job doze, capped at
# 3600s and always preceded by a "[Schedule] Next job" line. So past 75 minutes
# it is a stall, not a quiet patch.
#
# Docker will not restart an unhealthy container by itself, so this restarts the
# aimm program instead. supervisor respawns it (autorestart=true) with a fresh
# browser, while the container, the web UI and the log shipper survive.
set -eu

LOG=/root/.ai-marketplace-monitor/ai-marketplace-monitor.log
# 75 min — 15 minutes of headroom over the 60-minute maximum doze in monitor.py.
MAX_STALE_SECONDS="${RS_MAX_STALE_SECONDS:-4500}"

# Nothing written yet. start_period covers first boot; reporting a failure here
# would restart a monitor that is still opening its browser.
if [ ! -f "$LOG" ]; then
    exit 0
fi

age=$(( $(date +%s) - $(stat -c %Y "$LOG") ))

if [ "$age" -lt "$MAX_STALE_SECONDS" ]; then
    exit 0
fi

echo "rs-monitor: no log write for ${age}s (limit ${MAX_STALE_SECONDS}s) - restarting aimm"
# Never let a supervisorctl hiccup mask the unhealthy verdict below.
supervisorctl restart aimm || true
exit 1
