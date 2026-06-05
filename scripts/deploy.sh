#!/usr/bin/env sh
# deploy.sh — bring the stack up on a host that has Docker but no Node.
#
# Cut releases on a dev box (`pnpm release`); the remote only needs Docker and a
# POSIX shell. `docker compose up` runs Node *inside* the containers, so the host
# itself never needs a Node install — and this script reads the version straight
# out of package.json with sed rather than `node -p`.
#
# Typical remote flow:
#   git pull && scripts/deploy.sh
#
# Usage:
#   scripts/deploy.sh [version] [--no-build]
#
#   version     image tag to run (recycle-erp-*:<version>). Defaults to the
#               "version" field in package.json. Pass an older one to roll back,
#               e.g. `scripts/deploy.sh 0.1.3 --no-build`.
#   --no-build  run existing images instead of building from source first.

set -eu

# Locate repo root off this script's own path so CWD doesn't matter.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ROOT"

VERSION=""
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    -h|--help)  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*)        echo "error: unknown flag '$arg'" >&2; exit 2 ;;
    *)          VERSION="$arg" ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)
fi
[ -n "$VERSION" ] || { echo "error: could not read version from package.json" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || { echo "error: docker not found on PATH" >&2; exit 1; }

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
export APP_VERSION="$VERSION" GIT_SHA

printf '\033[1;36m▸ Deploying recycle-erp %s (sha %s)\033[0m\n' "$VERSION" "$GIT_SHA"
if [ "$BUILD" -eq 1 ]; then
  docker compose up -d --build
else
  docker compose up -d
fi

printf '\033[1;36m▸ Up. Current containers:\033[0m\n'
docker compose ps
