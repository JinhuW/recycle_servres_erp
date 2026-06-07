#!/usr/bin/env bash
# release.sh — cut a versioned release: bump SemVer, regenerate the changelog,
# tag, and build version-stamped Docker images.
#
# Usage:
#   scripts/release.sh <patch|minor|major> [--allow-dirty] [--no-build] [--deploy] [--dry-run]
#
# What it does, in order:
#   1. Pre-flight: must be on `main`, in sync with origin/main, clean tree
#      (unless --allow-dirty), then `pnpm typecheck` + `pnpm build`. Backend
#      tests run only if Postgres answers on 127.0.0.1:5432, else warn + skip.
#   2. Bump `version` in the root package.json (single source of truth).
#   3. Regenerate CHANGELOG.md from commits since the last tag, grouped by
#      Conventional-Commit type.
#   4. Commit `chore(release): vX.Y.Z`, then tag `vX.Y.Z`.
#   5. Build `recycle-erp-{backend,web}:X.Y.Z` (+ retag :latest) via compose
#      with APP_VERSION / GIT_SHA build args.
#
# By default it does NOT push or deploy — it prints the exact next commands so
# you stay in control. Pass --deploy to also push (main + tag) and bring the
# stack up on the freshly-built images (APP_VERSION=<new>). Phase 2 (a GitHub
# Action pushing to GHCR) can reuse the build step.

set -euo pipefail

# ── Locate repo root off the script's own path so CWD doesn't matter. ─────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

LEVEL=""
ALLOW_DIRTY=0
NO_BUILD=0
DRY_RUN=0
DEPLOY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major) LEVEL="$1"; shift ;;
    --allow-dirty)     ALLOW_DIRTY=1; shift ;;
    --no-build)        NO_BUILD=1; shift ;;
    --deploy)          DEPLOY=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [[ -z "$LEVEL" ]]; then
  echo "error: missing bump level. Usage: scripts/release.sh <patch|minor|major> [--allow-dirty] [--no-build] [--deploy] [--dry-run]" >&2
  exit 2
fi

# --deploy brings the stack up on the just-built images, so it can't run without
# a build.
if [[ "$DEPLOY" == "1" && "$NO_BUILD" == "1" ]]; then
  echo "error: --deploy needs the image build; drop --no-build" >&2
  exit 2
fi

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. Pre-flight ─────────────────────────────────────────────────────────────
say "Pre-flight checks"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || die "must be on 'main' (currently on '$BRANCH')"

git fetch --quiet origin main || warn "could not fetch origin/main — skipping sync check"
if git rev-parse --verify --quiet origin/main >/dev/null; then
  BEHIND="$(git rev-list --count HEAD..origin/main)"
  [[ "$BEHIND" == "0" ]] || die "local main is $BEHIND commit(s) behind origin/main — pull first"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$ALLOW_DIRTY" == "1" ]]; then
    warn "working tree is dirty — proceeding because --allow-dirty was passed"
  else
    die "working tree is dirty. Commit/stash first, or pass --allow-dirty"
  fi
fi

say "Typecheck + build"
pnpm typecheck
pnpm build

# Integration suite needs Postgres on 127.0.0.1:5432 (compose override). Probe
# the port instead of assuming — the prod host doesn't publish it.
if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then
  exec 3>&- 3<&-
  say "Postgres reachable — running backend tests"
  (cd apps/backend && npx vitest run)
else
  warn "Postgres not reachable on 127.0.0.1:5432 — skipping backend tests"
fi

# ── 2. Bump version ───────────────────────────────────────────────────────────
CURRENT="$(node -p "require('./package.json').version")"
NEW="$(node -e '
  const [maj,min,pat] = process.argv[1].split(".").map(Number);
  const lvl = process.argv[2];
  const v = lvl === "major" ? [maj+1,0,0] : lvl === "minor" ? [maj,min+1,0] : [maj,min,pat+1];
  process.stdout.write(v.join("."));
' "$CURRENT" "$LEVEL")"
TAG="v$NEW"
GIT_SHA="$(git rev-parse --short HEAD)"

say "Releasing $CURRENT → $NEW  (tag $TAG, commit $GIT_SHA)"

git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null \
  && die "tag $TAG already exists"

# ── 3. Changelog ──────────────────────────────────────────────────────────────
# Range = since the most recent tag, or whole history on the first release.
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
RANGE="HEAD"; [[ -n "$LAST_TAG" ]] && RANGE="$LAST_TAG..HEAD"

DATE="$(date +%Y-%m-%d)"
# Initialize empty (not bare `declare -a`) so ${#arr[@]} is defined under set -u.
FEAT=(); FIX=(); REF=(); PERF=(); OTHER=()
while IFS= read -r subj; do
  [[ -z "$subj" ]] && continue
  case "$subj" in
    chore\(release\):*) continue ;;                 # don't list prior release commits
    feat*)     FEAT+=("$subj") ;;
    fix*)      FIX+=("$subj") ;;
    refactor*) REF+=("$subj") ;;
    perf*)     PERF+=("$subj") ;;
    *)         OTHER+=("$subj") ;;
  esac
# tformat (not format) terminates every line with a newline, including the
# last — `git log --pretty=format:` omits the trailing newline, so the
# `while read` loop would silently drop the oldest commit in the range.
done < <(git log --no-merges --pretty=tformat:'%s' "$RANGE")

emit_section() {
  local title="$1"; shift
  printf '### %s\n' "$title"
  printf -- '- %s\n' "$@"
  printf '\n'
}

# Guard each call on length: ${#arr[@]} is set -u-safe for an empty array, and
# only expanding "${arr[@]}" when non-empty dodges the older-bash "unbound"
# error on empty-array expansion (and the stray-empty-bullet trap).
NEW_SECTION="$(
  printf '## [%s] - %s\n\n' "$NEW" "$DATE"
  (( ${#FEAT[@]}  )) && emit_section "Features"    "${FEAT[@]}"
  (( ${#FIX[@]}   )) && emit_section "Fixes"       "${FIX[@]}"
  (( ${#REF[@]}   )) && emit_section "Refactors"   "${REF[@]}"
  (( ${#PERF[@]}  )) && emit_section "Performance" "${PERF[@]}"
  (( ${#OTHER[@]} )) && emit_section "Other"       "${OTHER[@]}"
  true
)"

if [[ "$DRY_RUN" == "1" ]]; then
  say "DRY RUN — no files written, no tag, no build. Changelog preview:"
  printf '\n%s\n' "$NEW_SECTION"
  exit 0
fi

# Prepend under the "# Changelog" header (created on first run).
TMP="$(mktemp)"
{
  printf '# Changelog\n\n'
  printf 'All notable changes to this project. Generated by scripts/release.sh.\n\n'
  printf '%s\n' "$NEW_SECTION"
  if [[ -f CHANGELOG.md ]]; then
    # Keep prior release sections, but drop the header/preamble (everything up to
    # the first "## ") AND any manually-maintained "## [Unreleased]" section(s):
    # their bullets are regenerated from commit history into the new release
    # section above, so preserving them here would duplicate — and, run over many
    # releases, stack up orphaned "## [Unreleased]" headers.
    awk '
      /^## \[Unreleased\]/ { inunrel=1; started=1; next }
      /^## /               { inunrel=0; started=1 }
      !started             { next }
      inunrel              { next }
      { print }
    ' CHANGELOG.md
  fi
} > "$TMP"
mv "$TMP" CHANGELOG.md

# Bump package.json (node, to keep formatting + trailing newline stable).
node -e '
  const fs = require("fs");
  const p = "./package.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$NEW"

# ── 4. Commit + tag ───────────────────────────────────────────────────────────
say "Committing and tagging"
git add package.json CHANGELOG.md
git commit -m "chore(release): $TAG"
git tag -a "$TAG" -m "Release $TAG"

# ── 5. Build images ───────────────────────────────────────────────────────────
if [[ "$NO_BUILD" == "1" ]]; then
  warn "--no-build: skipping docker image build"
elif ! command -v docker >/dev/null; then
  warn "docker not found — skipping image build (run on the deploy host)"
else
  say "Building recycle-erp-{backend,web}:$NEW"
  APP_VERSION="$NEW" GIT_SHA="$GIT_SHA" docker compose build backend web
  docker tag "recycle-erp-backend:$NEW" "recycle-erp-backend:latest"
  docker tag "recycle-erp-web:$NEW"     "recycle-erp-web:latest"
fi

# ── 6. Deploy (opt-in) ────────────────────────────────────────────────────────
if [[ "$DEPLOY" == "1" ]]; then
  command -v docker >/dev/null || die "--deploy needs docker on this host"
  say "Pushing main + $TAG"
  git push origin main
  git push origin "$TAG"
  say "Bringing the stack up on $TAG"
  APP_VERSION="$NEW" GIT_SHA="$GIT_SHA" docker compose up -d

  cat <<EOF

$(say "Deployed $TAG.")  The stack is running the new images.

To roll back to the previous version on the host:

  APP_VERSION=$CURRENT docker compose up -d
EOF
  exit 0
fi

# ── Done ──────────────────────────────────────────────────────────────────────
cat <<EOF

$(say "Released $TAG locally.")  Next steps:

  git push origin main && git push origin $TAG
  APP_VERSION=$NEW docker compose up -d            # run the tagged images

  # …or re-run with --deploy to push and bring the stack up in one shot.

To roll back to the previous version on the host:

  APP_VERSION=$CURRENT docker compose up -d
EOF
