#!/bin/sh
# Launch the Facebook Marketplace monitor with secrets loaded.
# Invoked by the launchd agent (com.recycleservers.fbmonitor); can also be run
# by hand to reproduce exactly what the service does.
set -eu

ROOT="/Users/jinhu/Projects/recycle_servers/facebook_tracker"
cd "$ROOT"

# Load secrets (OPENROUTER_API_KEY, TELEGRAM_*) into the environment.
set -a
. "$ROOT/configs/secrets.env"
set +a

# exec so launchd tracks the aimm process directly (signals, restarts).
exec "$ROOT/.venv-aimm/bin/aimm" \
    --config "$ROOT/configs/master.toml" \
    --headless \
    --no-webui
