#!/usr/bin/env bash
# changelog.sh — build, check and draft CHANGELOG.md against the git tag history.
#
# Usage:
#   scripts/changelog.sh backfill [--dry-run]   rebuild CHANGELOG.md from every v* tag
#   scripts/changelog.sh check                  assert every tag has a section
#   scripts/changelog.sh draft [--since <ref>]  print a section skeleton for this branch
#
# The release flow this file serves is: push to `dev` → version-check.yml
# demands a bumped version *and* a matching `## [X.Y.Z]` section → CI tags
# `v<version>`. One tag, one section, forever. `scripts/release.sh` had its own
# generator for the retired Docker/`main` flow; this is the one that matches how
# releases actually happen.
#
# `backfill` is a rebuild, not an append: it re-emits the whole file from the
# tag list, reusing any hand-written section verbatim and generating one from
# the commit range for every tag that has none. Running it twice is a no-op.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CHANGELOG="CHANGELOG.md"

# Owner/repo for PR links, off the remote so a fork doesn't link to upstream.
REPO_SLUG="$(git remote get-url origin 2>/dev/null \
  | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')"
[[ -n "$REPO_SLUG" ]] || REPO_SLUG="JinhuW/recycle_servres_erp"

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

# ── Shared helpers ────────────────────────────────────────────────────────────

# Every v* tag, oldest first, as bare versions.
tag_versions() { git tag -l 'v*' --sort=v:refname | sed 's/^v//'; }

# Every version that already has a section in CHANGELOG.md ([Unreleased] is not
# one — the leading digit class excludes it).
section_versions() {
  [[ -f "$CHANGELOG" ]] || return 0
  grep -oE '^## \[[0-9][^]]*\]' "$CHANGELOG" | sed 's/^## \[//; s/\]$//'
}

# A commit subject as a changelog bullet: drop the redundant release marker the
# squash commits carry ("(v1.106.0)" — the section header already says it) and
# turn a trailing PR number into a link. ~25% of historical subjects have no
# (#NNN); those stay plain rather than linking somewhere wrong.
fmt_subject() {
  printf '%s' "$1" \
    | sed -E 's/ \(v[0-9]+\.[0-9]+\.[0-9]+\)//g' \
    | sed -E "s|\(#([0-9]+)\)\$|([#\1](https://github.com/$REPO_SLUG/pull/\1))|"
}

# ── backfill ──────────────────────────────────────────────────────────────────

# Emit one generated section for TAG, covering PREV_TAG..TAG (or the whole
# history when PREV_TAG is empty).
generate_section() {
  local version="$1" tag="$2" prev="$3"
  local date range
  date="$(git log -1 --format=%ad --date=short "$tag")"
  range="$tag"; [[ -n "$prev" ]] && range="$prev..$tag"

  local feat fix other
  feat="$(mktemp)"; fix="$(mktemp)"; other="$(mktemp)"

  local subj
  # tformat (not format) terminates every line, including the last — with
  # `format:` the `while read` loop silently drops the oldest commit in the
  # range. Same trap release.sh documents.
  while IFS= read -r subj; do
    [[ -z "$subj" ]] && continue
    case "$subj" in
      chore\(release\):*) continue ;;
      feat*) fmt_subject "$subj" >> "$feat"; printf '\n' >> "$feat" ;;
      fix*)  fmt_subject "$subj" >> "$fix";  printf '\n' >> "$fix" ;;
      *)     fmt_subject "$subj" >> "$other"; printf '\n' >> "$other" ;;
    esac
  done < <(git log --no-merges --pretty=tformat:'%s' "$range")

  printf '## [%s] - %s\n\n' "$version" "$date"
  local f title
  for f in "feat:Features" "fix:Fixes" "other:Other"; do
    title="${f#*:}"
    eval "src=\$${f%%:*}"
    [[ -s "$src" ]] || continue
    printf '### %s\n' "$title"
    sed 's/^/- /' "$src"
    printf '\n'
  done
  rm -f "$feat" "$fix" "$other"
}

backfill() {
  local dry_run="$1"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/cur"

  # Split the existing file into one file per section so hand-written prose can
  # be re-emitted verbatim. Everything before the first "## " (the header and
  # preamble) is dropped — it is rewritten below.
  if [[ -f "$CHANGELOG" ]]; then
    awk -v outdir="$tmp/cur" '
      # The appendix gets a stable name of its own: its heading carries no
      # [version], so a second backfill would otherwise fail to recognise it and
      # silently drop the prose it exists to preserve.
      /^## Pre-v/ { cur = outdir "/__appendix__"; next }
      /^## / {
        name = $0
        sub(/^## \[/, "", name); sub(/\].*$/, "", name)
        gsub(/[^A-Za-z0-9._-]/, "_", name)
        cur = outdir "/" name
        next
      }
      cur { print >> cur }
    ' "$CHANGELOG"
  fi

  # Section order is the union of tagged versions and versions that already have
  # a section: 1.9.0 has a hand-written section but was never tagged, so a
  # tags-only walk would silently delete it.
  local versions
  versions="$( { tag_versions; section_versions; } | sort -u | sort -rV )"

  {
    printf '# Changelog\n\n'
    cat <<'PREAMBLE'
Every release on `dev` has a section here, newest first. `version-check.yml`
fails a push that bumps `package.json` without adding one, so this file is the
complete record of what shipped and when — read it top-down to learn how the
system got here, and `docs/FEATURES.md` to learn what it does today.

Generated by `scripts/changelog.sh backfill`; new releases are written by hand
(`scripts/changelog.sh draft` prints a starting point). Sections at v1.16.1 and
older, and the appendix at the foot of this file, are hand-written prose from
the era before the checks existed and are richer than the generated bullets.

Every version `package.json` has ever held has a tag and a section here —
`scripts/changelog.sh check` asserts it. Four early releases (0.1.0, 1.9.0,
1.52.0, 1.53.0) shipped without a tag at the time and were tagged retroactively
at the last commit that carried each version.
PREAMBLE
    printf '\n## [Unreleased]\n\n'

    local v tag prev_tag section_file
    for v in $versions; do
      tag="v$v"
      section_file="$tmp/cur/$(printf '%s' "$v" | sed 's/[^A-Za-z0-9._-]/_/g')"
      if [[ -s "$section_file" ]]; then
        # Hand-written: keep the body exactly as it stands, normalising only
        # trailing blank lines. The awk split consumed the header line, so it
        # is re-emitted with whatever date it already carried.
        printf '## [%s]%s\n' "$v" "$(section_suffix "$v")"
        sed -e :a -e '/^\n*$/{$d;N;};/\n$/ba' "$section_file"
        printf '\n'
      elif git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
        prev_tag="$(prev_tag_of "$tag")"
        generate_section "$v" "$tag" "$prev_tag"
      fi
    done

    if [[ -s "$tmp/cur/__appendix__" ]]; then
      # Already migrated by an earlier backfill — re-emit it as it stands.
      printf '## Pre-v1.52 detail (unversioned)\n'
      sed -e :a -e '/^\n*$/{$d;N;};/\n$/ba' "$tmp/cur/__appendix__"
      printf '\n'
    elif [[ -s "$tmp/cur/Unreleased" ]]; then
      cat <<'APPENDIX'
## Pre-v1.52 detail (unversioned)

Written against a permanent `## [Unreleased]` heading between 2026-07 and
2026-08-06, before per-version sections resumed. These describe work shipped
between v1.17 and v1.51 and therefore **overlap** the generated bullets above
rather than replacing them; they are kept because the prose carries reasoning
the commit subjects do not, and it cannot be split across versions
automatically — it was rewritten from the subjects, so it no longer matches
them.

APPENDIX
      sed -e :a -e '/^\n*$/{$d;N;};/\n$/ba' "$tmp/cur/Unreleased"
      printf '\n'
    fi
  } > "$tmp/out.md"

  if [[ "$dry_run" == "1" ]]; then
    say "DRY RUN — nothing written. Preview:"
    cat "$tmp/out.md"
    return 0
  fi

  mv "$tmp/out.md" "$CHANGELOG"
  say "Wrote $CHANGELOG ($(grep -c '^## ' "$CHANGELOG") sections)."
}

# The tag immediately preceding TAG in version order, or empty for the first.
prev_tag_of() {
  git tag -l 'v*' --sort=v:refname | grep -B1 -x "$1" | head -1 | grep -vx "$1" || true
}

# Preserve the "- YYYY-MM-DD" that a hand-written header carried, or take the
# tag's date when it had none.
section_suffix() {
  local v="$1" line
  line="$(grep -m1 -E "^## \[$(sed 's/\./\\./g' <<<"$v")\]" "$CHANGELOG" 2>/dev/null || true)"
  if [[ "$line" == *" - "* ]]; then
    printf '%s' " - ${line##* - }"
  elif git rev-parse -q --verify "refs/tags/v$v" >/dev/null; then
    printf '%s' " - $(git log -1 --format=%ad --date=short "v$v")"
  fi
}

# ── check ─────────────────────────────────────────────────────────────────────

check() {
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  tag_versions | sort -u > "$tmp/tags"
  section_versions | sort -u > "$tmp/sections"

  local missing extra
  missing="$(comm -23 "$tmp/tags" "$tmp/sections")"
  extra="$(comm -13 "$tmp/tags" "$tmp/sections")"

  if [[ -n "$extra" ]]; then
    warn "sections with no tag — tag the release, or fix the header:"
    printf '    %s\n' $extra >&2
  fi
  if [[ -n "$missing" ]]; then
    die "$(printf '%s\n' "$missing" | wc -l | tr -d ' ') tag(s) have no CHANGELOG section:
$(printf '    %s\n' $missing)"
  fi
  say "OK — all $(wc -l < "$tmp/tags" | tr -d ' ') tags have a section."
}

# ── draft ─────────────────────────────────────────────────────────────────────

draft() {
  local since="${1:-origin/dev}"
  local version; version="$(node -p "require('./package.json').version")"
  git rev-parse -q --verify "$since" >/dev/null || die "unknown ref '$since'"

  printf '## [%s] - %s\n\n' "$version" "$(date +%Y-%m-%d)"
  local subj
  while IFS= read -r subj; do
    [[ -z "$subj" ]] && continue
    printf -- '- %s\n' "$(fmt_subject "$subj")"
  done < <(git log --no-merges --pretty=tformat:'%s' "$since..HEAD")
  cat >&2 <<'EOF'

Rewrite the bullets above as one entry per user-visible change: what changed,
and why it was worth doing. Group under ### Features / ### Fixes. Then paste it
under "## [Unreleased]" — or as its own section if the version is final.
EOF
}

# ── main ──────────────────────────────────────────────────────────────────────

cmd="${1:-}"; shift || true
case "$cmd" in
  backfill)
    dry=0
    [[ "${1:-}" == "--dry-run" ]] && dry=1
    backfill "$dry" ;;
  check) check ;;
  draft)
    since="origin/dev"
    [[ "${1:-}" == "--since" ]] && since="${2:?--since needs a ref}"
    draft "$since" ;;
  -h|--help|"") usage ;;
  *) die "unknown command '$cmd' — try --help" ;;
esac
