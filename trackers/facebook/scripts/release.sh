#!/bin/sh
# Cut a release: verify, bump, changelog, commit, tag.
#
#   scripts/release.sh patch          # 0.2.0 -> 0.2.1
#   scripts/release.sh minor          # 0.2.0 -> 0.3.0
#   scripts/release.sh major          # 0.2.0 -> 1.0.0
#   scripts/release.sh 0.4.2          # exactly this
#   scripts/release.sh --dry-run minor
#
# One version covers the whole system, because the whole system ships together:
# the coordinator, the poster, the configs, and the pinned revision of the
# vendored monitor. A tag is only useful here if it answers "what was deployed",
# and that question spans all four.
#
# Everything the tag claims is CHECKED before it is written — the tests, the
# absence of credentials, that the vendored checkout matches its pin, and that
# the generated worker configs are the ones master.toml and fleet.toml actually
# produce. A release that quietly ships stale shards is this project's most
# expensive failure mode: the fleet comes up, reports healthy, and searches the
# wrong cities with the wrong phrases.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY=""
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
BUMP="${1:-}"
[ -n "$BUMP" ] || { echo "usage: $0 [--dry-run] <major|minor|patch|X.Y.Z>" >&2; exit 2; }

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

CURRENT=$(cat VERSION)
case "$BUMP" in
    major|minor|patch)
        NEW=$(awk -F. -v part="$BUMP" '{
            if (part == "major") printf "%d.0.0", $1 + 1;
            else if (part == "minor") printf "%d.%d.0", $1, $2 + 1;
            else printf "%d.%d.%d", $1, $2, $3 + 1;
        }' VERSION)
        ;;
    [0-9]*.[0-9]*.[0-9]*) NEW="$BUMP" ;;
    *) echo "error: '$BUMP' is not a bump keyword or an X.Y.Z version" >&2; exit 2 ;;
esac

if [ "$NEW" = "$CURRENT" ]; then
    echo "error: VERSION is already $CURRENT — a release has to move it" >&2
    exit 2
fi

# Refuse to go backwards. Deploys are gated on "the VM does not already run
# this version", so a version that walks back over ground already deployed
# makes the release log ambiguous in the other direction.
if [ "$(printf '%s\n%s\n' "$CURRENT" "$NEW" | sort -V | tail -1)" != "$NEW" ]; then
    echo "error: $NEW is older than the current $CURRENT" >&2
    exit 2
fi

echo "release: $CURRENT -> $NEW${DRY:+  (dry run)}"

# ---------------------------------------------------------------- preflight
step "preflight"

git rev-parse --git-dir >/dev/null 2>&1 || { echo "  not a git repository" >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
    echo "  working tree is dirty; commit or stash first:" >&2
    git status --short | sed 's/^/      /' >&2
    exit 1
fi

if git rev-parse "v$NEW" >/dev/null 2>&1; then
    echo "  tag v$NEW already exists" >&2
    exit 1
fi

# A release with nothing written under [Unreleased] is one nobody can read
# later, which defeats the point of keeping the file.
if ! awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && NF' CHANGELOG.md | grep -q .; then
    echo "  CHANGELOG.md has nothing under [Unreleased]." >&2
    echo "  Write what changed before tagging it." >&2
    exit 1
fi

# ---------------------------------------------------------------- verify
step "no credentials in the tree"
sh scripts/check-secrets.sh --all

step "credential scanner still works"
sh scripts/tests/test-check-secrets.sh

step "deploy version gate still works"
sh scripts/tests/test-version-gate.sh

step "vendored checkouts match VENDOR.md"
sh scripts/check-vendor.sh

step "generated worker configs are current"
TMP_GEN=$(mktemp -d)
trap 'rm -rf "$TMP_GEN"' EXIT
PYTHONPATH=rs_coordinator "$ROOT/.venv-coordinator/bin/python" -m rs_coordinator.cli \
    gen-configs --master configs/master.toml --fleet configs/fleet.toml \
    --output "$TMP_GEN" >/dev/null
if diff -rq configs/generated "$TMP_GEN" >/dev/null 2>&1; then
    echo "  shards match master.toml + fleet.toml"
else
    echo "  DRIFT — configs/generated is not what gen-configs produces:" >&2
    diff -rq configs/generated "$TMP_GEN" | sed 's/^/      /' >&2
    echo "  run: rsc gen-configs" >&2
    exit 1
fi

step "tests"
AIMM_PYTHON="$ROOT/.venv-aimm/bin/python"
export AIMM_PYTHON

# NOT `pytest ... | tail -1`.
#
# /bin/sh has no pipefail, so a pipeline exits with the status of its LAST
# command — and `tail` always succeeds. Piping pytest into tail therefore hides
# every failure from `set -e`: the first run of this script sailed past "5
# failed, 71 passed", bumped the version and wrote a tag. That is the identical
# bug this release fixes in scripts/deploy.sh, which is a good argument for not
# writing the pattern anywhere.
#
# Output goes to a file, so the summary line is still all you see when it
# passes and the failures are all there when it does not.
run_suite() {
    suite_dir="$1"
    shift
    log=$(mktemp)
    if (cd "$suite_dir" && "$@") > "$log" 2>&1; then
        tail -1 "$log"
        rm -f "$log"
    else
        echo "  $suite_dir FAILED — not releasing" >&2
        cat "$log" >&2
        rm -f "$log"
        exit 1
    fi
}

run_suite rs_coordinator "$ROOT/.venv-coordinator/bin/python" -m pytest tests/ -q -p no:cacheprovider
run_suite rs_poster "$ROOT/.venv-coordinator/bin/python" -m pytest tests/ -q -p no:cacheprovider
run_suite rs_messenger "$ROOT/.venv-coordinator/bin/python" -m pytest tests/ -q -p no:cacheprovider
# test_facebook.py needs pytest-playwright, which the runtime venv does not have.
run_suite ai-marketplace-monitor "$AIMM_PYTHON" -m pytest tests/ -q \
    --ignore=tests/test_facebook.py -p no:cacheprovider

if [ -n "$DRY" ]; then
    step "dry run — nothing written"
    echo "  would set VERSION to $NEW, move [Unreleased] into [$NEW], commit and tag v$NEW"
    exit 0
fi

# ---------------------------------------------------------------- bump
step "bump to $NEW"
printf '%s\n' "$NEW" > VERSION

# The local packages carry the system version too, so `pip show` and an
# installed console script agree with the tag instead of reporting a number
# frozen at whenever the pyproject was written.
for f in rs_coordinator/pyproject.toml rs_poster/pyproject.toml rs_messenger/pyproject.toml; do
    python3 - "$f" "$NEW" <<'PY'
import re, sys
path, new = sys.argv[1], sys.argv[2]
with open(path) as fh:
    text = fh.read()
text, n = re.subn(r'(?m)^version = "[^"]+"$', f'version = "{new}"', text, count=1)
assert n == 1, f"no version line in {path}"
with open(path, "w") as fh:
    fh.write(text)
PY
    echo "  $f"
done

for f in rs_coordinator/rs_coordinator/__init__.py rs_poster/rs_poster/__init__.py \
         rs_messenger/rs_messenger/__init__.py; do
    python3 - "$f" "$NEW" <<'PY'
import re, sys
path, new = sys.argv[1], sys.argv[2]
with open(path) as fh:
    text = fh.read()
text, n = re.subn(r'(?m)^__version__ = "[^"]+"$', f'__version__ = "{new}"', text, count=1)
assert n == 1, f"no __version__ in {path}"
with open(path, "w") as fh:
    fh.write(text)
PY
    echo "  $f"
done

step "changelog"
python3 - "$NEW" <<'PY'
import datetime, pathlib, sys

new = sys.argv[1]
path = pathlib.Path("CHANGELOG.md")
text = path.read_text()
marker = "## [Unreleased]\n"
assert marker in text, "CHANGELOG.md has no [Unreleased] section"

head, tail = text.split(marker, 1)
# Everything up to the next release heading is what this version ships.
rest = tail.lstrip("\n")
today = datetime.date.today().isoformat()
path.write_text(f"{head}{marker}\n## [{new}] - {today}\n\n{rest}")
print(f"  [Unreleased] -> [{new}] - {today}")
PY

step "commit and tag"
git add -A
sh scripts/check-secrets.sh
git commit -q -m "Release v$NEW

$(awk -v v="$NEW" '
    $0 ~ "^## \\[" v "\\]" {f=1; next}
    /^## \[/ {f=0}
    f && (NF || prev) {print; prev = NF}
' CHANGELOG.md)

Vendored monitor pinned at $(git -C ai-marketplace-monitor rev-parse --short HEAD) (see VENDOR.md).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"

git tag -a "v$NEW" -m "v$NEW"
echo "  tagged v$NEW"

step "done"
echo "  $CURRENT -> $NEW"
echo "  deploy it with: scripts/deploy.sh"
