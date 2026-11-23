#!/bin/sh
# Prove release.sh reads --dry-run in any position and refuses stray arguments.
#
# Only the parser is sourced; release.sh itself never runs here, so nothing can
# bump, commit or tag.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/scripts/release-args.sh"
FAILURES=0

ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# parses <name> <want-dry> <want-bump> <args...>
parses() {
    name="$1"; want_dry="$2"; want_bump="$3"; shift 3
    if parse_release_args "$@" 2>/dev/null \
        && [ "$DRY" = "$want_dry" ] && [ "$BUMP" = "$want_bump" ]; then
        ok "$name"
    else
        fail "$name (status $?, DRY='$DRY' BUMP='$BUMP')"
    fi
}

# refuses <name> <args...>
refuses() {
    name="$1"; shift
    status=0
    parse_release_args "$@" 2>/dev/null || status=$?
    if [ "$status" = 2 ]; then ok "$name"; else fail "$name (status $status)"; fi
}

parses "--dry-run first" 1 patch --dry-run patch
parses "--dry-run after the bump" 1 patch patch --dry-run
parses "no flag is a real release" "" minor minor
parses "an exact version" "" 0.4.2 0.4.2
parses "--dry-run twice" 1 major --dry-run major --dry-run
refuses "no arguments"
refuses "only --dry-run" --dry-run
refuses "a misspelt flag" patch --dryrun
refuses "two bumps" patch minor
refuses "an extra argument after a dry run" --dry-run patch extra

[ "$FAILURES" = 0 ] || { echo "$FAILURES failing" >&2; exit 1; }
echo "release args: all ok"
