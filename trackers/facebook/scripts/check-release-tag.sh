#!/bin/sh
# Prove this tree is a release: clean, tagged, and unchanged since the tag.
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
#   facebook-tracker/v$VERSION tag
#                   only scripts/release.sh writes these, and it refuses to
#                   reuse one — so a new tag is proof of a real bump
#   tag is current  commits made after the tag would otherwise ship to the
#                   fleet wearing the previous release's number
#
# This tree lives at trackers/facebook/ inside the ERP monorepo, so all three are
# judged on this subtree only (pathspec `.`): ERP commits move HEAD and ERP edits
# dirty the worktree without changing a byte rsync ships. The tag prefix keeps
# these tags out of the ERP's own v* release tags.
set -eu

TAG_PREFIX="facebook-tracker/v"
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

git rev-parse --git-dir >/dev/null 2>&1 || { echo "  not a git repository" >&2; exit 1; }
[ -f VERSION ] || { echo "  no VERSION file in $ROOT" >&2; exit 1; }
VERSION=$(cat VERSION)

TAG="$TAG_PREFIX$VERSION"

if [ -n "$(git status --porcelain -- .)" ]; then
    echo "  working tree is dirty — what rsync ships is not what $TAG names:" >&2
    git status --short -- . | sed 's/^/      /' >&2
    echo "  commit it, then cut a release:  scripts/release.sh patch" >&2
    exit 1
fi

if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    echo "  VERSION says $VERSION, but no $TAG tag exists." >&2
    echo "  That number was written by hand; a release would have tagged it." >&2
    echo "  cut one:  scripts/release.sh patch      (or minor / major / X.Y.Z)" >&2
    exit 1
fi

# rev-list -n1 dereferences the annotated tag to the commit it wraps.
tagged=$(git rev-list -n1 "refs/tags/$TAG")
if ! git diff --quiet "$tagged" HEAD -- .; then
    ahead=$(git rev-list --count "$tagged"..HEAD -- .)
    echo "  $TAG points at $(git rev-parse --short "$tagged"), and this tree changed since." >&2
    echo "  $ahead commit(s) would ship to the fleet wearing $VERSION." >&2
    echo "  cut a release for them:  scripts/release.sh patch" >&2
    exit 1
fi

echo "  $TAG at $(git rev-parse --short "$tagged"), tree clean and unchanged since"
