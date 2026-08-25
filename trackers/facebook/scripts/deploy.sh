#!/bin/sh
# Push this tree to the homelab worker and PROVE the worker is running it.
#
#   scripts/deploy.sh            # test, sync, rebuild, restart, verify
#   scripts/deploy.sh check      # verify only — is the VM running this tree?
#   scripts/deploy.sh sync       # sync + restart, no image rebuild (config-only)
#   scripts/deploy.sh --redeploy # ship a version the VM already runs (see below)
#
# Every deploy must carry a version no deploy has carried before. `check` is
# exempt (it writes nothing); `sync` is not — a config change to the live fleet
# is exactly the kind of change "what is deployed?" has to be able to name.
# So the order is always: write CHANGELOG.md, `scripts/release.sh patch`, then
# this. --redeploy is the escape hatch for re-running a deploy that failed
# partway, and it says so in the Telegram notification.
#
# The failure this exists to prevent: the container kept running an image built
# hours earlier, so `title_prefilter` and `build_search_url` were in this tree,
# described as live in the README, and absent from the process. Everything
# reasoned from local source was wrong about the live system for a whole
# afternoon, and nothing in the deployment said so. `check` is the answer —
# it compares the actual bytes of every module in the container against this
# tree, and it is run automatically at the end of every deploy.
#
# What is deliberately NOT pushed: configs/secrets.env and configs/sessions/.
# The VM's copies are live credentials — the worker's Facebook cookies and its
# coordinator token — and the laptop's are for a different account and IP.
set -eu

VM="${RS_MONITOR_HOST:-jinhu@10.10.10.73}"
REMOTE="${RS_REMOTE_ROOT:-recycle_servers/facebook_tracker}"
C="${RS_MONITOR_CONTAINER:-rs-monitor}"
IMAGE="${RS_MONITOR_IMAGE:-aimm-recycle:latest}"
PKG=/usr/local/lib/python3.12/site-packages/ai_marketplace_monitor
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# What the VM says it is running. It lives at the root of $REMOTE, outside every
# directory rsync transfers, so --delete never prunes it.
STAMP=".rs-deployed"
cd "$ROOT"

MODE=deploy
REDEPLOY=0
for arg in "$@"; do
    case "$arg" in
        check|sync|deploy) MODE="$arg" ;;
        --redeploy)        REDEPLOY=1 ;;
        *) echo "usage: $0 [check|sync|deploy] [--redeploy]" >&2; exit 2 ;;
    esac
done

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- verify
# Compares the container's installed modules with this tree, file by file.
# A marker grep would only find the patches someone remembered to list; a
# checksum finds everything, including a module that failed to copy.
verify() {
    step "verify: does $C run this tree?"

    local_sums=$(cd src_for_sums 2>/dev/null || cd "$ROOT/ai-marketplace-monitor/src/ai_marketplace_monitor"; \
        find . -name '*.py' -exec md5sum {} + | sort -k2 | md5sum | cut -d' ' -f1)
    remote_sums=$(ssh "$VM" "docker exec $C sh -c 'cd $PKG && find . -name \"*.py\" -exec md5sum {} + | sort -k2 | md5sum | cut -d\" \" -f1'")

    if [ "$local_sums" = "$remote_sums" ]; then
        echo "  code:   MATCH ($local_sums)"
    else
        echo "  code:   DRIFT — local $local_sums vs running $remote_sums"
        echo "  differing modules:"
        ssh "$VM" "docker exec $C sh -c 'cd $PKG && md5sum \$(find . -name \"*.py\") | sort -k2'" \
            > /tmp/rs-remote-sums.txt 2>/dev/null || true
        (cd "$ROOT/ai-marketplace-monitor/src/ai_marketplace_monitor" && \
            md5sum $(find . -name '*.py') | sort -k2) > /tmp/rs-local-sums.txt
        diff /tmp/rs-local-sums.txt /tmp/rs-remote-sums.txt | grep '^[<>]' | awk '{print "    " $1, $3}' | sort -u -k2 | head -20
        DRIFT=1
    fi

    # The config is bind-mounted, so it can drift independently of the image.
    if ssh "$VM" "docker exec $C cat /root/.ai-marketplace-monitor/config.toml" \
        | diff -q - "$ROOT/configs/homelab.toml" >/dev/null 2>&1; then
        echo "  config: MATCH"
    else
        echo "  config: DRIFT — configs/homelab.toml differs from the mounted config"
        DRIFT=1
    fi

    # A restart that half-failed still leaves the old process running.
    ssh "$VM" "docker inspect $C --format '  uptime: started {{.State.StartedAt}}, restarts {{.RestartCount}}, running {{.State.Running}}'"

    # Boot errors are logged once and then buried under thousands of lines.
    # No '|| echo 0' here: grep -c already prints 0, and its exit status 1 on
    # no-match would make the substitution "0\n0" — which then reads as a
    # nonzero count and reports a clean boot as an error.
    boot_err=$(ssh "$VM" "docker exec $C sh -c 'head -60 /var/log/supervisor/aimm.log 2>/dev/null | grep -c ERROR' || true")
    [ "${boot_err:-0}" = "0" ] && echo "  boot:   clean" || {
        echo "  boot:   $boot_err ERROR line(s) — showing them:"
        ssh "$VM" "docker exec $C sh -c 'head -60 /var/log/supervisor/aimm.log | grep -A3 ERROR'" | sed 's/^/    /'
    }

    [ "${DRIFT:-0}" = "0" ] || { echo; echo "VERIFY FAILED — the worker is not running this tree."; exit 1; }
    echo; echo "verified: $C is running this tree."
}

if [ "$MODE" = "check" ]; then
    verify
    exit 0
fi

# ---------------------------------------------------------------- version gate
# Refuse to ship a version that is not a real release, or one the VM already
# runs. See scripts/check-release-tag.sh for the three git-side conditions and
# the release log this went wrong in; the fourth condition needs the VM.
step "version gate"
sh scripts/check-release-tag.sh

VERSION=$(cat "$ROOT/VERSION")
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
REDEPLOY_NOTE=""

# A tag at HEAD proves the version was bumped once. It does not stop the same
# tag being deployed twice, which is still a deploy with no bump behind it —
# and repeated same-version lines are exactly what made the release log
# unreadable. The VM is the only honest record of what it is running.
#
# An unreachable VM reads as "no stamp" and is allowed through: this gate exists
# to keep the release log honest, not to test connectivity, and the sync step
# below is where an unreachable VM properly fails the deploy.
LAST=$(ssh -o ConnectTimeout=10 "$VM" "cat $REMOTE/$STAMP 2>/dev/null" 2>/dev/null || true)
LAST_VERSION=${LAST%% *}

if [ -n "$LAST_VERSION" ] && [ "$LAST_VERSION" = "$VERSION" ]; then
    if [ "$REDEPLOY" = "1" ]; then
        echo "  $VM already runs $LAST"
        echo "  --redeploy given — shipping $VERSION again, and saying so in Telegram."
        REDEPLOY_NOTE=" (REDEPLOY - same version as the previous deploy)"
    else
        echo "  $VM already runs $LAST_VERSION — this tree is $VERSION too." >&2
        echo "  Deploying it again would log a second '$VERSION' to the Releases topic," >&2
        echo "  and nothing would say which of the two the fleet is running." >&2
        echo >&2
        echo "  bump it:      write CHANGELOG.md [Unreleased], then scripts/release.sh patch" >&2
        echo "  retrying a failed deploy?  scripts/deploy.sh --redeploy" >&2
        exit 1
    fi
elif [ -n "$LAST_VERSION" ]; then
    echo "  $VM runs $LAST_VERSION, shipping $VERSION"
else
    echo "  $VM has no deploy stamp yet — recording one after this deploy"
fi

# ---------------------------------------------------------------- test
# Local gate first. Pushing a tree whose tests fail just moves the failure
# somewhere with no test runner and a live Facebook session attached.
step "test"
.venv-aimm/bin/python -m pytest ai-marketplace-monitor/tests -q \
    --ignore=ai-marketplace-monitor/tests/test_facebook.py

# ---------------------------------------------------------------- config
# homelab.toml is generated. Regenerating here means a master.toml edit can
# never reach the VM without the container config that mirrors it.
step "regenerate configs/homelab.toml from master.toml"
sh deploy/make-homelab-config.sh

# ---------------------------------------------------------------- sync
step "sync -> $VM:$REMOTE"
rsync -az --delete --itemize-changes \
    --exclude '.git' --exclude '.venv*' --exclude '__pycache__' --exclude '*.egg-info' \
    --exclude '.pytest_cache' --exclude 'configs/secrets.env' --exclude 'configs/sessions' \
    --exclude 'data' --exclude 'logs' --exclude 'reports' --exclude '*.png' \
    ai-marketplace-monitor configs deploy scripts \
    rs_coordinator rs_poster rs_messenger rs_console \
    CHANGELOG.md README.md VENDOR.md VERSION \
    "$VM:$REMOTE/"

# ---------------------------------------------------------------- build
if [ "$MODE" != "sync" ]; then
    step "rebuild $IMAGE"
    # NOT `docker build ... | tail -5`.
    #
    # This is /bin/sh with no pipefail, so a pipeline's exit status is `tail`'s,
    # and `tail` always succeeds. A failed build therefore exited 0, `set -e`
    # saw nothing wrong, and the next step --force-recreate'd the live monitor
    # onto the PREVIOUS image — a deploy that reports success and changes
    # nothing, which is the exact class of failure `verify` exists to catch.
    #
    # The output goes to a file so the tail is still short on success and the
    # whole thing is there to read on failure.
    build_log=$(mktemp)
    if ssh "$VM" "cd $REMOTE/ai-marketplace-monitor && docker build -t $IMAGE ." \
            > "$build_log" 2>&1; then
        tail -5 "$build_log"
        rm -f "$build_log"
    else
        echo "  build FAILED — the running container was left untouched." >&2
        tail -40 "$build_log" >&2
        rm -f "$build_log"
        exit 1
    fi
fi

# ---------------------------------------------------------------- restart
step "restart $C"
# `up -d` alone will not recreate the container when only the image changed
# underneath a tag it already has by name, so force it.
ssh "$VM" "cd $REMOTE && docker compose -f deploy/docker-compose.homelab.yml up -d --force-recreate monitor"

# Give supervisord time to spawn aimm and write its first lines; verifying
# before that reads the previous boot's log.
ssh "$VM" "sleep 20"

verify

# ---------------------------------------------------------------- record
# Stamp the VM with what it now runs, so the next deploy can refuse to ship
# this version a second time. Written only after verify passed: stamping a
# deploy that did not land would block the retry that fixes it.
step "record $VERSION on $VM"
ssh "$VM" "printf '%s %s %s\n' '$VERSION' '$SHA' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > $REMOTE/$STAMP"
echo "  $VERSION $SHA"

# ---------------------------------------------------------------- notify
# Tell the Telegram chat a deploy happened, reusing the coordinator's live
# credentials on the VM (the laptop deliberately has none). Non-fatal: a
# missed notification must never mark a verified deploy as failed.
step "notify telegram"
DEPLOY_DESC="v$VERSION ($SHA)$REDEPLOY_NOTE"
if ssh "$VM" "docker exec -i rs-coordinator python - \"Deployed facebook_tracker $DEPLOY_DESC to rs-monitor - verified running this tree.\"" <<'PYEOF'
import os, sys, urllib.parse, urllib.request

params = {"chat_id": os.environ["TELEGRAM_CHAT_ID"], "text": sys.argv[1]}
# Post into the 📦 Releases forum topic when configured (secrets.env,
# created by scripts/setup-telegram-topics.py); General topic otherwise.
if os.environ.get("TELEGRAM_TOPIC_RELEASES"):
    params["message_thread_id"] = os.environ["TELEGRAM_TOPIC_RELEASES"]
data = urllib.parse.urlencode(params).encode()
urllib.request.urlopen(
    "https://api.telegram.org/bot" + os.environ["TELEGRAM_TOKEN"] + "/sendMessage",
    data,
    timeout=10,
)
PYEOF
then
    echo "  sent"
else
    echo "  telegram notification failed (deploy itself is verified)"
fi
