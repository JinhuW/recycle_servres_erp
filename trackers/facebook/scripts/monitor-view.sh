#!/bin/sh
# Look at what the homelab monitor's browser is doing right now.
#
#   scripts/monitor-view.sh            # print the tunnel command for a VNC viewer
#   scripts/monitor-view.sh shot       # save a PNG of the current screen
#
# The container runs x11vnc on 5900 with -nopw, and that port is deliberately
# NOT published: an unauthenticated VNC server is a logged-in Facebook browser
# anyone on the LAN could drive. It is reached instead by forwarding through
# ssh, which is already authenticated, straight to the container's address on
# the docker bridge.
#
# The web UI on 8467 is not an alternative — see deploy/README.md. It never
# starts under this deployment.
set -eu

VM="${RS_MONITOR_HOST:-jinhu@10.10.10.73}"
CONTAINER="${RS_MONITOR_CONTAINER:-rs-monitor}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# The container's IP changes every time it is recreated, so resolve it rather
# than hardcoding one that will be stale by the next `docker compose up`.
IP=$(ssh "$VM" "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $CONTAINER" | awk '{print $1}')
[ -n "$IP" ] || { echo "error: could not resolve $CONTAINER's IP on $VM" >&2; exit 1; }

case "${1:-tunnel}" in
    tunnel)
        cat <<EOF
$CONTAINER is at $IP:5900 on $VM.

Open the tunnel (leave it running):

    ssh -L 5900:$IP:5900 $VM

Then point a VNC viewer at 127.0.0.1:5900 — no password. On macOS:

    open vnc://127.0.0.1:5900

The screen is 1280x800 and shows the live Chromium the monitor is driving.
Do not click anything mid-sweep: the session is shared (-shared), so your
input goes to the same browser the scraper is using.
EOF
        ;;
    shot)
        OUT="${2:-$ROOT/reports/monitor-screen.png}"
        mkdir -p "$(dirname "$OUT")"
        # Run the grab ON the VM — it can route to the docker bridge directly,
        # so this needs no tunnel and no VNC client installed anywhere.
        ssh "$VM" 'cat > /tmp/vnc-screenshot.py' < "$ROOT/scripts/vnc-screenshot.py"
        ssh "$VM" "python3 /tmp/vnc-screenshot.py $IP 5900 /tmp/monitor-screen.png"
        scp -q "$VM:/tmp/monitor-screen.png" "$OUT"
        echo "wrote $OUT"
        ;;
    *)
        echo "usage: $0 [tunnel|shot [path.png]]" >&2
        exit 2
        ;;
esac
