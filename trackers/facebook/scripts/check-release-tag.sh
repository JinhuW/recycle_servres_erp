#!/bin/sh
# Prove this tree is a release: clean, tagged, and the tag is HEAD.
#
#   scripts/check-release-tag.sh              # this tree
#   scripts/check-release-tag.sh /some/repo   # another checkout (the tests use this)
#
# scripts/deploy.sh calls this before it ships anything.
#
# The failure this exists to prevent: `cat VERSION` was the only thing deploy.sh
# knew about versions, and nothing obliged anyone to run scripts/release.sh —
# the only script that ever bumps that file. So the 📦 Releases topic logged
# deploy after deploy as the same "0.4.0", and that number was not a release at
# all: no v0.4.0 tag, no release commit, just a hand-edited VERSION sitting in a
# dirty tree. A release log that repeats one version cannot answer the only
# question it exists to answer — which build is on the VM right now?
#
# Three conditions. All three are true of a real release; none of them is true
# of a VERSION someone edited by hand:
#
#   clean tree      rsync ships the working tree, not the tag, so uncommitted
#                   edits make the tag a lie about what is running on the VM
#   v$VERSION tag   only scripts/release.sh writes these, and it refuses to
#                   reuse one — so a new tag is proof of a real bump
#   tag is HEAD     commits made after the tag would otherwise ship to the
#                   fleet wearing the previous release's number
set -eu

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

git rev-parse --git-dir >/dev/null 2>&1 || { echo "  not a git repository" >&2; exit 1; }
[ -f VERSION ] || { echo "  no VERSION file in $ROOT" >&2; exit 1; }
VERSION=$(cat VERSION)

if [ -n "$(git status --porcelain)" ]; then
    echo "  working tree is dirty — what rsync ships is not what v$VERSION names:" >&2
    git status --short | sed 's/^/      /' >&2
    echo "  commit it, then cut a release:  scripts/release.sh patch" >&2
    exit 1
fi

if ! git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    echo "  VERSION says $VERSION, but no v$VERSION tag exists." >&2
    echo "  That number was written by hand; a release would have tagged it." >&2
    echo "  cut one:  scripts/release.sh patch      (or minor / major / X.Y.Z)" >&2
    exit 1
fi

# rev-list -n1 dereferences the annotated tag to the commit it wraps.
tagged=$(git rev-list -n1 "refs/tags/v$VERSION")
head=$(git rev-parse HEAD)
if [ "$tagged" != "$head" ]; then
    ahead=$(git rev-list --count "$tagged"..HEAD)
    echo "  v$VERSION points at $(git rev-parse --short "$tagged"), HEAD is $(git rev-parse --short "$head")." >&2
    echo "  $ahead commit(s) would ship to the fleet wearing $VERSION." >&2
    echo "  cut a release for them:  scripts/release.sh patch" >&2
    exit 1
fi

echo "  v$VERSION at $(git rev-parse --short HEAD), tree clean"
