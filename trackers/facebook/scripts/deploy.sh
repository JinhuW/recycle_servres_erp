#!/bin/sh
# Push this tree to the homelab VM and PROVE the coordinator and every worker
# run it.
#
#   scripts/deploy.sh            # test, sync, rebuild, restart, verify
#   scripts/deploy.sh check      # verify only — is the VM running this tree?
#   scripts/deploy.sh sync       # sync + restart, no image rebuild (config-only)
#   scripts/deploy.sh --redeploy # ship a version the VM already runs (see below)
#   RS_DEPLOY_HOLD="rs-monitor-va1 rs-monitor-va2" scripts/deploy.sh
#                                # leave these compose workers running untouched
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
# What is deliberately never pushed, and never deleted on the VM, is listed in
# scripts/deploy.rsync-filter. The VM's secrets, sessions and per-worker tokens
# are live credentials written there by hand. A dev checkout's copies belong to
# a different account and IP, and a checkout without them would have --delete
# remove the VM's. The dev machine's Facebook logins and 2FA never leave it.
set -eu

VM="${RS_MONITOR_HOST:-jinhu@10.10.10.73}"
REMOTE="${RS_REMOTE_ROOT:-recycle_servers/facebook_tracker}"
IMAGE="${RS_MONITOR_IMAGE:-aimm-recycle:latest}"
# A private registry other worker hosts pull from (deploy/docker-compose.registry.yml),
# e.g. 10.10.10.73:5000. Unset: the image exists on this VM only.
REGISTRY="${RS_REGISTRY:-}"
# Compose workers this deploy must not recreate, by container name: one whose
# restart would cost something, such as a login held only in memory until its
# next sweep, or a locked account that would retry its password from a fresh
# browser. They keep running their current image; verify names them as held.
HOLD=" $(printf '%s' "${RS_DEPLOY_HOLD:-}" | tr ',' ' ') "
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

held() {
    case "$HOLD" in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# Whether the VM runs its workers through rs-fleetd. Then a deploy rolls the
# new image out through the coordinator instead of recreating compose workers:
# recreating one the agent has adopted would put its session in two browsers.
fleet_mode() {
    ssh "$VM" "docker inspect rs-fleetd >/dev/null 2>&1" </dev/null
}

# Every worker on the VM, one per line: "<compose file> <service> <container>
# <config>". Read from the compose files themselves, so a worker added by
# copying one is restarted and verified without editing this script.
homelab_workers() {
    for f in deploy/docker-compose.homelab*.yml; do
        service=$(sed -n '/^services:/{n;s/^ *\([a-z0-9-]*\):.*/\1/p;}' "$f")
        container=$(sed -n 's/^ *container_name: *//p' "$f")
        config=$(sed -n 's#^ *- \.\./configs/\([a-z0-9-]*\.toml\):.*#\1#p' "$f")
        printf '%s %s %s %s\n' "$f" "$service" "$container" "$config"
    done
}

# A worker config as the VM should hold it: this tree's copy with the settings
# saved from the ERP written in (rs_console/settings.py). A console that
# predates saved settings has none, so the tree's copy is then the answer.
render_config() {
    if ssh "$VM" "docker exec rs-console python -c 'import rs_console.settings'" >/dev/null 2>&1; then
        ssh "$VM" "docker exec -i rs-console python -m rs_console.settings render --config $(basename "$1")" < "$1"
    else
        cat "$1"
    fi
}

# ---------------------------------------------------------------- verify
# Compares the container's installed modules with this tree, file by file.
# A marker grep would only find the patches someone remembered to list; a
# checksum finds everything, including a module that failed to copy.
verify_worker() {
    C=$1
    config=$2
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
    # Only homelab.toml is generated from this tree; the regional configs are
    # the VM's own, edited from the ERP, so there is nothing here to hold
    # them against.
    if [ "$config" = "homelab.toml" ]; then
        expected=$(mktemp)
        render_config "$ROOT/configs/homelab.toml" > "$expected"
        if ssh "$VM" "docker exec $C cat /root/.ai-marketplace-monitor/config.toml" \
            | diff -q - "$expected" >/dev/null 2>&1; then
            echo "  config: MATCH"
        else
            echo "  config: DRIFT — configs/homelab.toml (plus saved settings) differs from the mounted config"
            DRIFT=1
        fi
        rm -f "$expected"
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
}

coordinator_version() {
    ssh "$VM" "docker exec rs-coordinator python -c 'import json,urllib.request;print(json.load(urllib.request.urlopen(\"http://127.0.0.1:8500/healthz\"))[\"version\"])'" 2>/dev/null </dev/null
}

# A fleet deploy only starts the rollout, which moves one worker at a time and
# waits for each to heartbeat on the new version. So this checks the workers
# already on it, and names the ones the rollout has yet to reach.
verify_fleet() {
    FAILED=0
    target="aimm-recycle:$(cat "$ROOT/VERSION")"
    [ -z "$REGISTRY" ] || target="$REGISTRY/$target"
    for c in $(ssh "$VM" "docker ps --filter label=rs.fleet.managed=1 --format '{{.Names}}'" </dev/null); do
        image=$(ssh "$VM" "docker inspect $c --format '{{index .Config.Labels \"rs.fleet.image\"}}'" </dev/null)
        if [ "$image" = "$target" ]; then
            DRIFT=0
            verify_worker "$c" none
            [ "$DRIFT" = "0" ] || FAILED=1
        else
            step "verify: $c"
            echo "  still on $image; the rollout reaches it in turn"
        fi
    done
    step "the rollout"
    ssh "$VM" "docker exec rs-coordinator rsc fleet state" </dev/null | sed 's/^/  /'
}

verify() {
    if fleet_mode; then
        verify_fleet
        DRIFT=$FAILED
        verify_coordinator
        return
    fi
    # A for loop, not `homelab_workers | while read`: every ssh in
    # verify_worker would read the rest of the list from that pipe as stdin.
    FAILED=0
    old_ifs=$IFS
    IFS='
'
    for line in $(homelab_workers); do
        IFS=$old_ifs
        # shellcheck disable=SC2086 # split the line into its four fields
        set -- $line
        if held "$3"; then
            step "verify: $3"
            echo "  held: left running its previous image, as RS_DEPLOY_HOLD asked"
            continue
        fi
        DRIFT=0
        verify_worker "$3" "$4"
        [ "$DRIFT" = "0" ] || FAILED=1
    done
    IFS=$old_ifs
    DRIFT=$FAILED
    verify_coordinator
}

verify_coordinator() {
    # `sync` rebuilds no image, the coordinator's included.
    if [ "$MODE" != "sync" ]; then
        step "verify: rs-coordinator"
        coordinator=$(coordinator_version || echo unreachable)
        if [ "$coordinator" = "$(cat "$ROOT/VERSION")" ]; then
            echo "  version: MATCH ($coordinator)"
        else
            echo "  version: DRIFT — running $coordinator, this tree is $(cat "$ROOT/VERSION")"
            DRIFT=1
        fi
    fi
    [ "${DRIFT:-0}" = "0" ] || { echo; echo "VERIFY FAILED — the fleet is not running this tree."; exit 1; }
    echo; echo "verified: every worker and the coordinator run this tree."
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

# A current tag proves the version was bumped once. It does not stop the same
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
rsync -az --delete --itemize-changes --filter="merge scripts/deploy.rsync-filter" \
    ai-marketplace-monitor configs deploy scripts \
    rs_coordinator rs_poster rs_messenger rs_console rs_fleetd \
    CHANGELOG.md README.md VENDOR.md VERSION \
    "$VM:$REMOTE/"

# ---------------------------------------------------------------- worker configs
# The rsync above skips configs/homelab*.toml (deploy.rsync-filter). They go
# through the console instead, which writes in the settings saved from the
# ERP; a plain sync would put master.toml's values back. They are written in
# place because each is a single-file bind mount, which pins an inode: a
# replaced file stays invisible to the containers that mount it. The console
# is recreated first, for its own mounts and so it has this tree's renderer.
step "worker configs, through rs-console"
CONSOLE_BUILD=""
[ "$MODE" = "sync" ] || CONSOLE_BUILD="--build"
# A new worker's config must exist before the console mounts it: Docker turns
# a missing single-file mount source into a directory.
for config in configs/homelab*.toml; do
    ssh "$VM" "[ -e $REMOTE/$config ] || cat > $REMOTE/$config" < "$config"
done
ssh "$VM" "cd $REMOTE && docker compose -f deploy/docker-compose.console.yml up -d $CONSOLE_BUILD --force-recreate console"
for config in configs/homelab*.toml; do
    ssh "$VM" "out=\$(mktemp) && docker exec -i rs-console python -m rs_console.settings render --config $(basename "$config") > \$out && cat \$out > $REMOTE/$config && rm -f \$out" < "$config"
    echo "  $config"
done
# A worker rs-fleetd runs reads its config from the coordinator, not from the
# file above; this hands it the same rendering.
if fleet_mode; then
    ssh "$VM" "docker exec rs-console python -m rs_console.settings publish" | sed 's/^/  /'
fi

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
    # The image carries its build identity (reported in every heartbeat, shown
    # per worker on the fleet dashboard). The commit is read here, not on the
    # VM: rsync ships no .git, so the VM cannot know what it is running.
    MONITOR_COMMIT=$(git -C "$ROOT/ai-marketplace-monitor" rev-parse --short HEAD 2>/dev/null || echo unknown)
    # Tagged with the version too: a fleet release names the exact image, and
    # rolling back is releasing the previous tag, still on the host.
    if ssh "$VM" "cd $REMOTE/ai-marketplace-monitor && docker build \
            --build-arg RS_VERSION=$VERSION --build-arg RS_MONITOR_COMMIT=$MONITOR_COMMIT \
            -t $IMAGE -t aimm-recycle:$VERSION ." \
            > "$build_log" 2>&1; then
        tail -5 "$build_log"
        rm -f "$build_log"
    else
        echo "  build FAILED — the running container was left untouched." >&2
        tail -40 "$build_log" >&2
        rm -f "$build_log"
        exit 1
    fi
    if [ -n "$REGISTRY" ]; then
        step "push to $REGISTRY"
        ssh "$VM" "docker tag aimm-recycle:$VERSION $REGISTRY/aimm-recycle:$VERSION && docker push -q $REGISTRY/aimm-recycle:$VERSION"
    fi
fi

# ---------------------------------------------------------------- coordinator
# Before the workers, which ask it for their device as they boot. A worker that
# finds it down boots the device it cached last time, so the gap costs nothing;
# the old coordinator keeps answering until compose swaps it.
if [ "$MODE" != "sync" ]; then
    step "rebuild and restart rs-coordinator"
    # Published on the LAN too when the VM says so, for worker hosts other
    # than this one (deploy/docker-compose.coordinator-lan.yml).
    ssh "$VM" "cd $REMOTE && if [ -e configs/secrets.coordinator-lan.env ]; then \
        docker compose --env-file configs/secrets.coordinator-lan.env -f deploy/docker-compose.coordinator.yml \
            -f deploy/docker-compose.coordinator-lan.yml up -d --build --force-recreate coordinator; \
        else docker compose -f deploy/docker-compose.coordinator.yml up -d --build --force-recreate coordinator; fi"
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
        [ "$(coordinator_version)" = "$VERSION" ] && break
        sleep 5
    done
    echo "  running $(coordinator_version || echo 'nothing yet')"
fi

# ---------------------------------------------------------------- fleet
# Through the coordinator: rs-fleetd recreates one worker at a time, and the
# next waits for the last to heartbeat on the new version (fleet.py). The
# agent itself is rebuilt first, so the release meets this tree's agent.
if fleet_mode; then
    step "rebuild rs-fleetd"
    ssh "$VM" "cd $REMOTE && docker compose --env-file configs/secrets.fleetd.env -f deploy/docker-compose.fleetd.yml up -d --build --force-recreate fleetd"
    if [ "$MODE" != "sync" ]; then
        RELEASE_IMAGE="aimm-recycle:$VERSION"
        [ -z "$REGISTRY" ] || RELEASE_IMAGE="$REGISTRY/$RELEASE_IMAGE"
        step "release $RELEASE_IMAGE"
        ssh "$VM" "docker exec rs-coordinator rsc fleet release $VERSION --image $RELEASE_IMAGE"
    fi
fi

# ---------------------------------------------------------------- restart
# Every compose worker, one at a time. Only rs-monitor used to be recreated, so
# the others kept whatever image they were last started from, for releases on
# end. Staggered: each recreate starts a sweep at once, and ten logins in the
# same minute from one host is a pattern worth not showing Facebook. Skipped
# under rs-fleetd, which has taken them over (see `fleet_mode`).
fleet_mode || homelab_workers | while read -r file service container _config; do
    if held "$container"; then
        step "hold $container"
        echo "  not recreated: RS_DEPLOY_HOLD"
        continue
    fi
    step "restart $container"
    # `up -d` alone will not recreate the container when only the image
    # changed underneath a tag it already has by name, so force it. The old
    # container gets stop_grace_period to save its session first.
    ssh "$VM" "cd $REMOTE && docker compose -f $file up -d --force-recreate $service" </dev/null
    # Give supervisord time to spawn aimm and write its first lines; verifying
    # before that reads the previous boot's log.
    ssh "$VM" "sleep 20" </dev/null
done

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
WORKER_COUNT=$(homelab_workers | wc -l | tr -d ' ')
HELD_NOTE=""
[ -z "$(printf '%s' "$HOLD" | tr -d ' ')" ] || HELD_NOTE=" Held on their previous image:$HOLD"
if ssh "$VM" "docker exec -i rs-coordinator python - \"Deployed facebook_tracker $DEPLOY_DESC to the coordinator and $WORKER_COUNT workers - verified running this tree.$HELD_NOTE\"" <<'PYEOF'
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
