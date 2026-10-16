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
git -C "$WORK/good" tag -a facebook-tracker/v1.2.3 -m facebook-tracker/v1.2.3
allows "a clean tree tagged facebook-tracker/v1.2.3 at HEAD" "$WORK/good"

# -- things that must be refused --------------------------------------------
mkrepo "$WORK/untagged" 1.2.3
refuses "a VERSION with no matching tag (hand-edited)" "$WORK/untagged"

mkrepo "$WORK/dirty" 1.2.3
git -C "$WORK/dirty" tag -a facebook-tracker/v1.2.3 -m facebook-tracker/v1.2.3
printf 'uncommitted\n' > "$WORK/dirty/configs.toml"
refuses "a dirty tree, even at the tag" "$WORK/dirty"

mkrepo "$WORK/behind" 1.2.3
git -C "$WORK/behind" tag -a facebook-tracker/v1.2.3 -m facebook-tracker/v1.2.3
printf 'later work\n' > "$WORK/behind/new.py"
git -C "$WORK/behind" add -A
git -C "$WORK/behind" commit -qm "work after the tag"
refuses "commits after the tag (they would ship as 1.2.3)" "$WORK/behind"

# The bump that edits VERSION but forgets to tag: v1.2.3 exists, 1.2.4 does not.
mkrepo "$WORK/bumped" 1.2.3
git -C "$WORK/bumped" tag -a facebook-tracker/v1.2.3 -m facebook-tracker/v1.2.3
printf '1.2.4\n' > "$WORK/bumped/VERSION"
git -C "$WORK/bumped" commit -qam "bump to 1.2.4 without releasing"
refuses "a bumped VERSION whose tag was never written" "$WORK/bumped"

# A lightweight tag is still a tag; rev-list -n1 has to dereference both kinds.
mkrepo "$WORK/lightweight" 1.2.3
git -C "$WORK/lightweight" tag facebook-tracker/v1.2.3
allows "a lightweight tag at HEAD" "$WORK/lightweight"

# -- nested in the monorepo -------------------------------------------------
# This tree lives at trackers/facebook/ inside the ERP repo. Commits and edits
# elsewhere in the repo move HEAD and dirty the worktree without changing a
# byte that rsync ships, so only this subtree may count against the release.
mkmono() {
    mkdir -p "$1/trackers/facebook"
    git -C "$1" init -q
    git -C "$1" config user.email t@example.com
    git -C "$1" config user.name test
    printf '%s\n' "$2" > "$1/trackers/facebook/VERSION"
    printf 'erp\n' > "$1/README.md"
    git -C "$1" add -A
    git -C "$1" commit -qm "v$2"
    git -C "$1" tag -a "facebook-tracker/v$2" -m "facebook-tracker/v$2"
}

mkmono "$WORK/mono-good" 1.2.3
allows "nested: tagged at HEAD" "$WORK/mono-good/trackers/facebook"

mkmono "$WORK/mono-erp-commit" 1.2.3
printf 'erp change\n' >> "$WORK/mono-erp-commit/README.md"
git -C "$WORK/mono-erp-commit" commit -qam "erp work after the tag"
allows "nested: commits outside this tree after the tag" "$WORK/mono-erp-commit/trackers/facebook"

mkmono "$WORK/mono-erp-dirty" 1.2.3
printf 'uncommitted erp edit\n' >> "$WORK/mono-erp-dirty/README.md"
allows "nested: a dirty file outside this tree" "$WORK/mono-erp-dirty/trackers/facebook"

mkmono "$WORK/mono-behind" 1.2.3
printf 'later work\n' > "$WORK/mono-behind/trackers/facebook/new.py"
git -C "$WORK/mono-behind" add -A
git -C "$WORK/mono-behind" commit -qm "tracker work after the tag"
refuses "nested: commits inside this tree after the tag" "$WORK/mono-behind/trackers/facebook"

mkmono "$WORK/mono-dirty" 1.2.3
printf 'uncommitted\n' > "$WORK/mono-dirty/trackers/facebook/configs.toml"
refuses "nested: a dirty file inside this tree" "$WORK/mono-dirty/trackers/facebook"

mkmono "$WORK/mono-bare-tag" 1.2.3
git -C "$WORK/mono-bare-tag" tag -d facebook-tracker/v1.2.3 >/dev/null
git -C "$WORK/mono-bare-tag" tag -a v1.2.3 -m "an ERP release, not ours"
refuses "nested: an unprefixed v1.2.3 tag (the ERP's namespace)" "$WORK/mono-bare-tag/trackers/facebook"

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "all version-gate checks passed"
else
    echo "$FAILURES check(s) failed" >&2
    exit 1
fi
