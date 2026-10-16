#!/bin/sh
# Derive configs/homelab.toml from configs/master.toml.
#
# The only difference is storage_state_path: master.toml carries a path
# relative to the repo (for a laptop run), while the container needs an
# absolute one. supervisord does not guarantee its children's working
# directory, so a relative path inside the container is a coin flip.
#
# Run this after any change to master.toml, then restart the container:
#   sh deploy/make-homelab-config.sh && docker compose -f deploy/docker-compose.homelab.yml up -d
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/configs/master.toml"
OUT="$ROOT/configs/homelab.toml"

[ -f "$SRC" ] || { echo "error: $SRC not found" >&2; exit 1; }

{
    printf '# GENERATED from master.toml by deploy/make-homelab-config.sh — do not edit.\n'
    printf '# Regenerate after changing master.toml, then restart the container.\n\n'
    sed 's#storage_state_path = "configs/sessions/personal.json"#storage_state_path = "/data/fb_state.json"#' "$SRC"
} > "$OUT"

grep -q 'storage_state_path = "/data/fb_state.json"' "$OUT" || {
    echo "error: storage_state_path was not rewritten — did master.toml change that line?" >&2
    exit 1
}
echo "wrote $OUT"
