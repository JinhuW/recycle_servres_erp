#!/bin/sh
# A10-21: run a copy of check-secrets.sh over fake credential files (fake values only).
T="$(dirname "$0")/a10-21-tree"
for f in configs/secrets.fleetd.env configs/account_info.txt configs/secrets.env; do
  printf '%s -> ' "$f"; sh "$T/scripts/check-secrets.sh" "$f" >/dev/null 2>&1 && echo "PASSED (not refused)" || echo "refused"
done
