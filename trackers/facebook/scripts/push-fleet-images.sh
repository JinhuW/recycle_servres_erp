#!/bin/sh
# Build the two fleet images for linux/amd64 on this Mac and push them to the
# private GitHub Container Registry packages:
#
#   <registry>/<namespace>/aimm-recycle:<trackers/facebook/VERSION>   the worker
#   <registry>/<namespace>/fleet-agent:<root package.json version>    the host agent
#
#   scripts/push-fleet-images.sh                 # both, pushed
#   scripts/push-fleet-images.sh --no-push       # both, built only (a dry run)
#   scripts/push-fleet-images.sh --only worker   # or --only agent
#
# Why by hand: the worker image carries the vendored monitor, which is
# gitignored here (VENDOR.md), so CI cannot build it without a private mirror.
# GHCR is the registry while it works; the OCI Container Registry repositories
# created as a fallback (sin.ocir.io/ax6usa8hwbie) stay empty unless GHCR stops
# working. A package first pushed by a user token is private; fleet hosts pull
# with a classic read:packages token (docs/superpowers/plans/
# 2026-10-24-erp-fleet/HOSTS.md).
#
# Before a push, log in once with the gh CLI's token (it carries write:packages):
#   gh auth token | docker login ghcr.io -u jinhuw --password-stdin
#
# Environment:
#   REGISTRY         ghcr.io            registry host (sin.ocir.io for the OCI fallback)
#   NAMESPACE        jinhuw             owner or namespace (ax6usa8hwbie on OCI)
#   BUILDX_BUILDER   multiarch          a docker-container builder that can build amd64
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)        # trackers/facebook
REPO=$(cd "$ROOT/../.." && pwd)               # the monorepo root
REGISTRY=${REGISTRY:-ghcr.io}
NAMESPACE=${NAMESPACE:-jinhuw}
BUILDER=${BUILDX_BUILDER:-multiarch}
PUSH=1
ONLY=both

while [ $# -gt 0 ]; do
    case "$1" in
        --no-push) PUSH=0 ;;
        --only) shift; ONLY=${1:-} ;;
        -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done
case "$ONLY" in both|worker|agent) ;; *) echo "--only takes worker or agent" >&2; exit 2 ;; esac

die() { echo "  $*" >&2; exit 1; }

docker buildx inspect "$BUILDER" >/dev/null 2>&1 \
    || docker buildx create --name "$BUILDER" --driver docker-container >/dev/null

# Provenance attestations would add an "unknown/unknown" manifest next to the
# image in the registry's list, which reads as a second image.
if [ "$PUSH" = 1 ]; then OUT="--push"; else OUT="--output=type=cacheonly"; fi

build() {   # <image ref> <context> <dockerfile> [build args...]
    ref=$1 ctx=$2 file=$3; shift 3
    echo "== $ref ($( [ "$PUSH" = 1 ] && echo push || echo build only ))"
    docker buildx build --builder "$BUILDER" --platform linux/amd64 \
        --provenance=false $OUT -f "$file" -t "$ref" "$@" "$ctx"
}

if [ "$ONLY" != agent ]; then
    MON="$ROOT/ai-marketplace-monitor"
    [ -d "$MON/.git" ] || die "ai-marketplace-monitor is missing; see VENDOR.md to clone it"
    # The same column check-vendor.sh reads, so the image is the monitor the
    # release was tested against and nothing else.
    PIN=$(awk -F'|' -v p='`ai-marketplace-monitor/`' '$2 ~ p {gsub(/[ `]/,"",$5); print $5}' "$ROOT/VENDOR.md")
    HEAD=$(git -C "$MON" rev-parse HEAD)
    [ -n "$PIN" ] && [ "$HEAD" = "$PIN" ] || die "ai-marketplace-monitor is at $HEAD, VENDOR.md pins ${PIN:-nothing}; refusing"
    [ -z "$(git -C "$MON" status --porcelain)" ] || die "ai-marketplace-monitor has uncommitted changes; the image would not be $HEAD"
    VERSION=$(cat "$ROOT/VERSION")
    # A pushed tag is what a fleet release names; it must be a real release,
    # the same gate deploy.sh applies. A dry run may build any tree.
    [ "$PUSH" = 0 ] || sh "$ROOT/scripts/check-release-tag.sh"
    build "$REGISTRY/$NAMESPACE/aimm-recycle:$VERSION" "$ROOT" "$ROOT/deploy/Dockerfile.worker" \
        --build-arg RS_VERSION="$VERSION" \
        --build-arg RS_MONITOR_COMMIT="$(git -C "$MON" rev-parse --short HEAD)"
fi

if [ "$ONLY" != worker ]; then
    AGENT_VERSION=$(node -p "require('$REPO/package.json').version")
    build "$REGISTRY/$NAMESPACE/fleet-agent:$AGENT_VERSION" "$REPO" "$REPO/apps/fleet-agent/Dockerfile"
fi
