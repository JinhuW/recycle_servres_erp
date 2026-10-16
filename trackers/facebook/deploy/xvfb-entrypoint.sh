#!/bin/sh
# Start a virtual display, then exec the command passed to the container.
#
# Both browser-driving workers on this node — rs-messenger and rs-poster —
# drive a real, non-headless Chromium (Facebook serves a stripped,
# automation-flagged page to headless), so each needs an X server. The base
# image ships Xvfb but no supervisord entry for it under this entrypoint, so
# start it here and let it be reaped with the container.
#
#   command: ["rs-messenger", "run", ...]     -> the bridge loop
#   command: ["rs-poster", "renew"]           -> the daily repost
set -eu

: "${DISPLAY:=:99}"
export DISPLAY

if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    Xvfb "$DISPLAY" -screen 0 "${SCREEN_GEOMETRY:-1280x800x24}" -nolisten tcp &
    # Give Xvfb a moment to come up before Chromium reaches for it.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
        sleep 0.3
    done
fi

exec "$@"
