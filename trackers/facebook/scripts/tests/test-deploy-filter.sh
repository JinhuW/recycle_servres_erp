#!/bin/sh
# Prove the deploy's rsync filter keeps the VM's own files and never ships the
# dev machine's logins, with the same --delete that deploy.sh runs.
#
# Some files in configs/ exist only on the VM: per-worker tokens written there
# by hand, proxy lists, account dumps. --delete removes whatever the sender
# lacks, so a deploy from a fresh checkout would have quietly wiped them, and
# its exclude list also shipped the dev-only Facebook logins and 2FA seeds. The
# filter only shows that it works by moving real files, so this moves them.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FILTER="$ROOT/scripts/deploy.rsync-filter"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILURES=0

ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# put <file> <content> — write a fixture file, creating its directory.
put() {
    mkdir -p "$(dirname "$1")"
    printf '%s\n' "$2" > "$1"
}

# The same shape as deploy.sh: named sources from inside the tree, and the
# parent directory as the destination.
sync_tree() {
    (cd "$1" && rsync -a --delete --filter="merge $FILTER" \
        configs scripts rs_console "$2/")
}

# has <name> <file> <content> — the file exists with exactly this content.
has() {
    if [ -f "$2" ] && [ "$(cat "$2")" = "$3" ]; then
        ok "$1"
    elif [ -f "$2" ]; then
        fail "$1 (holds '$(cat "$2")')"
    else
        fail "$1 (missing)"
    fi
}

# lacks <name> <path> — nothing exists at this path.
lacks() {
    if [ -e "$2" ]; then fail "$1 (exists)"; else ok "$1"; fi
}

# -- a checkout that lacks the VM's own files -------------------------------
# A fresh clone, or this Mac. It holds the tracked tree plus the dev-only
# login files, and none of what was written by hand on the VM.
DEV="$WORK/fresh/dev"
VM="$WORK/fresh/vm"

put "$DEV/configs/master.toml"          "master from dev"
put "$DEV/configs/secrets.env.example"  "example from dev"
put "$DEV/configs/account_info.txt"     "dev login and 2fa"
put "$DEV/configs/account_info.txt.bak" "older dev login and 2fa"
put "$DEV/configs/data.txt"             "dev scratch logins"
put "$DEV/scripts/deploy.sh"            "deploy"
put "$DEV/rs_console/app.py"            "app"
put "$DEV/rs_console/logs/console.log"  "dev log"
put "$DEV/rs_console/data/console.db"   "dev db"
# Parity with today's rules, not a property anyone wants: the tracked
# rs_console static icon is a .png too, and it never ships.
put "$DEV/rs_console/static/icon.png"   "png"

put "$VM/configs/master.toml"             "master on the vm, stale"
put "$VM/configs/secrets.env.example"     "example on the vm, stale"
put "$VM/configs/secrets.env"             "live vm secrets"
put "$VM/configs/sessions/worker.json"    "live vm session"
put "$VM/configs/secrets.homelab-x.env"   "live worker token"
put "$VM/configs/secrets.env.bak-1"       "secrets backup"
put "$VM/configs/proxies.decodo.txt"      "live proxies"
put "$VM/configs/accounts/acct-1.json"    "account dump"
put "$VM/configs/generated/w.toml"        "worker shard"
put "$VM/scripts/old.sh"                  "removed on dev"

sync_tree "$DEV" "$VM"

echo "a checkout that lacks the VM's own files:"
has   "VM-only secrets.homelab-x.env survives" "$VM/configs/secrets.homelab-x.env" "live worker token"
has   "VM-only secrets.env.bak-1 survives"     "$VM/configs/secrets.env.bak-1"     "secrets backup"
has   "VM-only proxies.decodo.txt survives"    "$VM/configs/proxies.decodo.txt"    "live proxies"
has   "VM-only accounts/ survives"             "$VM/configs/accounts/acct-1.json"  "account dump"
has   "VM-only generated/w.toml survives"      "$VM/configs/generated/w.toml"      "worker shard"
has   "secrets.env is not deleted"             "$VM/configs/secrets.env"           "live vm secrets"
has   "sessions/ is not deleted"               "$VM/configs/sessions/worker.json"  "live vm session"
lacks "account_info.txt is never sent"         "$VM/configs/account_info.txt"
lacks "account_info.txt.bak is never sent"     "$VM/configs/account_info.txt.bak"
lacks "data.txt is never sent"                 "$VM/configs/data.txt"
lacks "logs/ is not sent"                      "$VM/rs_console/logs"
lacks "data/ is not sent"                      "$VM/rs_console/data"
lacks "*.png is not sent (today's behaviour)"  "$VM/rs_console/static/icon.png"
has   "master.toml arrives with dev's content" "$VM/configs/master.toml"           "master from dev"
has   "secrets.env.example arrives"            "$VM/configs/secrets.env.example"   "example from dev"
has   "a tracked file arrives"                 "$VM/rs_console/app.py"             "app"
lacks "a file removed on dev is deleted"       "$VM/scripts/old.sh"

# -- a checkout holding stale copies of the VM's files ----------------------
# A dev machine that once copied the VM's secrets down. Its copies are for a
# different account, IP or day, and must never replace the live ones.
DEV="$WORK/stale/dev"
VM="$WORK/stale/vm"

put "$DEV/configs/master.toml"            "master from dev"
put "$DEV/configs/secrets.env"            "dev secrets"
put "$DEV/configs/sessions/worker.json"   "dev session"
put "$DEV/configs/sessions/dev-only.json" "dev-only session"
put "$DEV/configs/secrets.homelab-y.env"  "dev"
put "$DEV/configs/proxies.decodo.txt"     "dev proxies"
put "$DEV/configs/generated/z.toml"       "dev shard"
put "$DEV/configs/homelab-ne.toml"        "worker config from dev"
put "$DEV/scripts/deploy.sh"              "deploy"
put "$DEV/rs_console/app.py"              "app"

put "$VM/configs/secrets.env"             "live vm secrets"
put "$VM/configs/sessions/worker.json"    "live vm session"
put "$VM/configs/secrets.homelab-y.env"   "vm"
put "$VM/configs/proxies.decodo.txt"      "live proxies"
put "$VM/configs/generated/z.toml"        "worker shard"
put "$VM/configs/homelab-ne.toml"         "worker config with saved settings"

sync_tree "$DEV" "$VM"

echo "a checkout holding stale copies of the VM's files:"
has   "secrets.homelab-y.env keeps the VM's copy" "$VM/configs/secrets.homelab-y.env" "vm"
has   "proxies.decodo.txt keeps the VM's copy"    "$VM/configs/proxies.decodo.txt"    "live proxies"
has   "generated/z.toml keeps the VM's copy"      "$VM/configs/generated/z.toml"      "worker shard"
has   "homelab-ne.toml is left to deploy.sh"      "$VM/configs/homelab-ne.toml"       "worker config with saved settings"
has   "secrets.env keeps the VM's copy"           "$VM/configs/secrets.env"           "live vm secrets"
has   "sessions/ keeps the VM's copy"             "$VM/configs/sessions/worker.json"  "live vm session"
lacks "a dev-only session is never sent"          "$VM/configs/sessions/dev-only.json"
has   "master.toml arrives with dev's content"    "$VM/configs/master.toml"           "master from dev"

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "all deploy-filter checks passed"
else
    echo "$FAILURES check(s) failed" >&2
    exit 1
fi
