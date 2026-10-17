#!/bin/sh
# Build the monitor image (aimm-recycle:latest) on this host, stamped with the
# build identity every worker reports in its heartbeat.
#
# Why this exists: deploys on the VM are done by hand (deploy.sh's rsync/tag
# gate does not apply to this checkout), and a bare
# `docker build -t aimm-recycle:latest ai-marketplace-monitor` leaves
# RS_VERSION and RS_MONITOR_COMMIT at their Dockerfile default, "unknown". The
# fleet dashboard (rs-console, the ERP's Facebook tracker page) then shows
# every worker's build as "unknown (unknown)" and flags it as differing from
# the coordinator.
#
# Usage: scripts/build-monitor-image.sh [image]   (default aimm-recycle:latest)
# Building does not touch running containers; recreate each monitor afterwards
# (and mind that a restart starts an immediate sweep).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${1:-${RS_MONITOR_IMAGE:-aimm-recycle:latest}}
VERSION=$(cat "$ROOT/VERSION")
COMMIT=$(git -C "$ROOT" rev-parse --short HEAD)
# Uncommitted changes under the monitor mean the image is not that commit;
# say so rather than wear its hash.
if [ -n "$(git -C "$ROOT" status --porcelain -- ai-marketplace-monitor)" ]; then
    COMMIT="$COMMIT-dirty"
fi

echo "building $IMAGE as $VERSION ($COMMIT)"
docker build -t "$IMAGE" \
    --build-arg RS_VERSION="$VERSION" \
    --build-arg RS_MONITOR_COMMIT="$COMMIT" \
    "$ROOT/ai-marketplace-monitor"
