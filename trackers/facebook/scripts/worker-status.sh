#!/bin/sh
# Everything you need to answer "is the homelab worker actually working?"
#
#   scripts/worker-status.sh          # the whole check
#   scripts/worker-status.sh log      # follow its log live
#   scripts/worker-status.sh alerts   # every alert verdict, to reconcile
#                                     # against the Telegram chat
#
# The Facebook fleet on 10.10.10.73 is ONE worker: the rs-monitor container,
# registered with the coordinator as homelab-1. The sg-* / toronto-1 boxes in
# ~/worker-logs are the REDDIT tracker on their own VMs — different project,
# different image (ghcr.io/jinhuw/reddits_tracker). Do not read them as
# Facebook fleet health.
set -eu

VM="${RS_MONITOR_HOST:-jinhu@10.10.10.73}"
C="${RS_MONITOR_CONTAINER:-rs-monitor}"
COORD="${RS_COORDINATOR_CONTAINER:-rs-coordinator}"
LOG=/root/.ai-marketplace-monitor/ai-marketplace-monitor.log

if [ "${1:-status}" = "log" ]; then
    exec ssh -t "$VM" "docker exec $C tail -f $LOG"
fi

if [ "${1:-status}" = "alerts" ]; then
    # One line per listing that cleared the rating threshold, saying whether
    # the message actually left the process. Rows here and messages in the
    # Telegram chat should correspond one to one; anything in the chat with no
    # SENT row (or the reverse) is the discrepancy worth chasing.
    ssh "$VM" "docker exec $C sh -c 'grep -h \"\[Alert\]\" ${LOG}* 2>/dev/null | sed \"s/\[[0-9][0-9]\/[^]]*\]//g\"'" || true
    echo
    echo "(empty means either no listing has cleared the threshold, or the"
    echo " container predates this log line — rebuild aimm-recycle to get it.)"
    exit 0
fi

ssh "$VM" "
set -u
echo '=== containers ==='
docker ps --filter name=$C --filter name=$COORD --format '{{.Names}}  {{.Status}}'

echo
echo '=== fleet registry (coordinator) ==='
docker exec $COORD rsc status 2>&1 | head -20
echo '(the monitor re-sends its last state every 5 minutes, so a heartbeat older'
echo ' than ~10 minutes means the process is gone or cannot reach the coordinator.'
echo ' The STATE is only re-checked at the top of each search, though: a session'
echo ' that dies mid-sweep still reads HEALTHY until the next search starts.)'

echo
echo '=== coordinator health ==='
curl -s http://127.0.0.1:8500/healthz; echo

echo
echo '=== is the monitor actually moving? ==='
# The log is the only honest liveness signal: it is written continuously while
# a sweep runs, so its mtime is never more than a listing-fetch old.
docker exec $C sh -c 'date -u +\"now      %Y-%m-%d %H:%M:%S UTC\"; stat -c \"log wrote %y\" $LOG'

echo
echo '=== last searches ==='
docker exec $C sh -c 'grep -h \"Searching facebook\" $LOG | sed \"s/\[[^]]*\]//g\" | tail -5'

echo
echo '=== boot-time errors (web UI, session, config) ==='
docker exec $C sh -c 'head -40 /var/log/supervisor/aimm.log | grep -A3 ERROR || echo \"(none)\"'

echo
echo '=== alert verdicts, this log ==='
docker exec $C sh -c 'grep -h \"\[Alert\]\" $LOG | sed \"s/\[[0-9][0-9]\/[^]]*\]//g\" | tail -10' || true
# grep -c already prints 0 when it matches nothing; the '|| echo 0' this used
# to carry made the substitution two words, and printf then reran its format.
docker exec $C sh -c 'printf \"SENT=%s  NOT-SENT=%s\n\" \"\$(grep -hc \"\[Alert\] SENT\" $LOG)\" \"\$(grep -hc \"\[Alert\] NOT SENT\" $LOG)\"' || true
echo '(these rows should match the Telegram chat one for one)'
"
