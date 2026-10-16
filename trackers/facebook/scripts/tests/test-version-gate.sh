#!/bin/sh
# Prove check-release-tag.sh still refuses the four trees it exists to refuse,
# and still lets a real release through.
#
# A gate that has never been watched to fail is indistinguishable from one that
# waves everything past — and "waves everything past" is precisely what the
# deploy pipeline did before this: it read VERSION, asked nothing of it, and
# logged the same 0.4.0 to the Releases topic on every deploy for days.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$ROOT/scripts/check-release-tag.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILURES=0

ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

refuses() {
    if sh "$CHECK" "$2" >/dev/null 2>&1; then fail "$1 (was allowed)"; else ok "$1"; fi
}
allows() {
    if sh "$CHECK" "$2" >/dev/null 2>&1; then ok "$1"; else fail "$1 (was refused)"; fi
}

# A throwaway repo at $1 whose VERSION is $2, committed. No tag yet.
# -c keeps the fixtures independent of whatever the real user's git config says.
mkrepo() {
    mkdir -p "$1"
    git -C "$1" init -q
    git -C "$1" config user.email t@example.com
    git -C "$1" config user.name test
    printf '%s\n' "$2" > "$1/VERSION"
    git -C "$1" add -A
    git -C "$1" commit -qm "v$2"
}

# -- the one tree that must be allowed --------------------------------------
mkrepo "$WORK/good" 1.2.3
git -C "$WORK/good" tag -a v1.2.3 -m v1.2.3
allows "a clean tree tagged v1.2.3 at HEAD" "$WORK/good"

# -- things that must be refused --------------------------------------------
mkrepo "$WORK/untagged" 1.2.3
refuses "a VERSION with no matching tag (hand-edited)" "$WORK/untagged"

mkrepo "$WORK/dirty" 1.2.3
git -C "$WORK/dirty" tag -a v1.2.3 -m v1.2.3
printf 'uncommitted\n' > "$WORK/dirty/configs.toml"
refuses "a dirty tree, even at the tag" "$WORK/dirty"

mkrepo "$WORK/behind" 1.2.3
git -C "$WORK/behind" tag -a v1.2.3 -m v1.2.3
printf 'later work\n' > "$WORK/behind/new.py"
git -C "$WORK/behind" add -A
git -C "$WORK/behind" commit -qm "work after the tag"
refuses "commits after the tag (they would ship as 1.2.3)" "$WORK/behind"

# The bump that edits VERSION but forgets to tag: v1.2.3 exists, 1.2.4 does not.
mkrepo "$WORK/bumped" 1.2.3
git -C "$WORK/bumped" tag -a v1.2.3 -m v1.2.3
printf '1.2.4\n' > "$WORK/bumped/VERSION"
git -C "$WORK/bumped" commit -qam "bump to 1.2.4 without releasing"
refuses "a bumped VERSION whose tag was never written" "$WORK/bumped"

# A lightweight tag is still a tag; rev-list -n1 has to dereference both kinds.
mkrepo "$WORK/lightweight" 1.2.3
git -C "$WORK/lightweight" tag v1.2.3
allows "a lightweight tag at HEAD" "$WORK/lightweight"

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "all version-gate checks passed"
else
    echo "$FAILURES check(s) failed" >&2
    exit 1
fi
