#!/bin/sh
# Are the vendored checkouts the ones VENDOR.md says they are?
#
#   scripts/check-vendor.sh          # verify; non-zero on drift
#   scripts/check-vendor.sh update   # rewrite the pins to match the tree
#
# The vendored projects are gitignored here (see VENDOR.md for why), so this
# repository's history says nothing at all about which revision of the monitor a
# given release was built against. That is the gap this closes: without it, a
# tag records the coordinator and the configs precisely and the engine that
# actually does the searching not at all.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE="${1:-check}"
STATUS=0

# path:branch — the pin itself is read out of VENDOR.md, so there is one place
# to change and no second list to drift.
for entry in "ai-marketplace-monitor:recycle-patches" "facebook-marketplace-bot:"; do
    path="${entry%%:*}"
    want_branch="${entry#*:}"

    if [ ! -d "$path/.git" ]; then
        echo "  $path: MISSING — see VENDOR.md to reconstitute it" >&2
        STATUS=1
        continue
    fi

    head=$(git -C "$path" rev-parse HEAD)
    # Column 5 of this path's row in VENDOR.md's table.
    pinned=$(awk -F'|' -v p="\`$path/\`" '$2 ~ p {gsub(/[ `]/,"",$5); print $5}' VENDOR.md)

    if [ "$MODE" = "update" ]; then
        if [ -n "$pinned" ] && [ "$pinned" != "$head" ]; then
            sed -i '' "s/$pinned/$head/" VENDOR.md
            echo "  $path: pin updated -> $head"
        else
            echo "  $path: pin already current"
        fi
        continue
    fi

    if [ "$pinned" != "$head" ]; then
        echo "  $path: DRIFT — VENDOR.md pins $pinned, working copy is $head" >&2
        echo "      run 'scripts/check-vendor.sh update' if the move was intended" >&2
        STATUS=1
    else
        echo "  $path: pinned at $head"
    fi

    if [ -n "$want_branch" ]; then
        branch=$(git -C "$path" rev-parse --abbrev-ref HEAD)
        [ "$branch" = "$want_branch" ] || {
            echo "  $path: on branch '$branch', expected '$want_branch'" >&2
            STATUS=1
        }
    fi

    # Uncommitted work in a vendored checkout means the pin describes something
    # that is not what is on disk, and the deploy rsyncs what is on disk.
    if [ -n "$(git -C "$path" status --porcelain)" ]; then
        echo "  $path: has uncommitted changes — the pin does not describe the tree" >&2
        git -C "$path" status --short | sed 's/^/      /' >&2
        STATUS=1
    fi
done

exit $STATUS
