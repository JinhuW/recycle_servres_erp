#!/usr/bin/env bash
# new-session.sh — start a Claude Code session on its own branch, in its own
# git worktree, so several sessions can run side by side without fighting over
# the single shared checkout.
#
# Usage:
#   scripts/new-session.sh                      # branch session/<timestamp>, then launch claude
#   scripts/new-session.sh feat/orders-filter   # explicit branch name
#   scripts/new-session.sh --print-only [name]  # create it, print the path, don't launch
#   scripts/new-session.sh --list               # show current session worktrees
#   scripts/new-session.sh --prune              # remove session worktrees that are clean + merged
#
# Flags:
#   --no-install     skip `pnpm install` in the new worktree
#   --base <ref>     branch from <ref> instead of origin/dev
#   -- <args...>     everything after `--` is passed through to `claude`
#
# What it does, in order:
#   1. Fetch origin/dev (warn + fall back to the local copy if offline).
#   2. `git worktree add -b <branch> .claude/worktrees/<slug> origin/dev`.
#   3. Copy the gitignored local files a worktree needs to run (.env).
#   4. `pnpm install` inside it (hardlinks from the pnpm store, so it is cheap).
#   5. cd there and exec `claude`.
#
# Every session branches from origin/dev — never main — per the repo workflow.
# Worktrees live under .claude/worktrees/ and are gitignored.
#
# All progress output goes to stderr; the worktree path is the only thing
# written to stdout, so `--print-only` is safe to capture in a variable.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_ROOT="$REPO_ROOT/.claude/worktrees"
BASE_REF="origin/dev"

# Gitignored files a fresh worktree needs before anything will run.
LOCAL_FILES=(".env")

MODE="launch"
DO_INSTALL=1
NAME=""
CLAUDE_ARGS=()

log()  { printf '  %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --print-only) MODE="print"; shift ;;
    --list)       MODE="list"; shift ;;
    --prune)      MODE="prune"; shift ;;
    --no-install) DO_INSTALL=0; shift ;;
    --base)       [ $# -ge 2 ] || die "--base needs a ref"; BASE_REF="$2"; shift 2 ;;
    --help|-h)    sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
    --)           shift; CLAUDE_ARGS=("$@"); break ;;
    -*)           die "unknown flag: $1" ;;
    *)            [ -z "$NAME" ] || die "unexpected argument: $1"; NAME="$1"; shift ;;
  esac
done

# Path of every worktree git currently knows about, one per line.
registered_worktrees() {
  git -C "$REPO_ROOT" worktree list --porcelain \
    | awk '/^worktree /{ print substr($0, 10) }'
}

list_sessions() {
  local found=0 path branch state
  while IFS= read -r path; do
    case "$path" in "$WORKTREE_ROOT"/*) ;; *) continue ;; esac
    found=1
    branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '(detached)')"
    if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
      state="dirty"
    elif [ -n "$(git -C "$path" log --oneline "$BASE_REF..HEAD" 2>/dev/null)" ]; then
      state="unmerged commits"
    else
      state="clean + merged"
    fi
    printf '  %-34s %-44s %s\n' "$(basename "$path")" "$branch" "$state" >&2
  done < <(registered_worktrees)
  [ "$found" -eq 1 ] || log "no session worktrees"
}

# Only ever removes worktrees that are BOTH clean and fully merged into the base
# ref, so this can never discard work. Anything else is reported and left alone.
prune_sessions() {
  git -C "$REPO_ROOT" fetch --quiet origin dev 2>/dev/null || warn "could not fetch origin/dev; pruning against the local copy"

  local removed=0 kept=0 path branch
  while IFS= read -r path; do
    case "$path" in "$WORKTREE_ROOT"/*) ;; *) continue ;; esac

    branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

    if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
      log "keep   $(basename "$path") — uncommitted changes"; kept=$((kept + 1)); continue
    fi
    if [ -n "$branch" ] && [ -n "$(git -C "$path" log --oneline "$BASE_REF..$branch" 2>/dev/null)" ]; then
      log "keep   $(basename "$path") — commits not in $BASE_REF"; kept=$((kept + 1)); continue
    fi

    git -C "$REPO_ROOT" worktree remove "$path"
    [ -n "$branch" ] && git -C "$REPO_ROOT" branch -D "$branch" >/dev/null
    log "remove $(basename "$path")${branch:+ ($branch)}"
    removed=$((removed + 1))
  done < <(registered_worktrees)

  git -C "$REPO_ROOT" worktree prune
  log "removed $removed, kept $kept"
}

create_session() {
  local branch slug path timestamp

  timestamp="$(date +%Y%m%d-%H%M%S)"
  branch="${NAME:-session/$timestamp}"
  # One directory per branch; '/' is not usable in a directory name here.
  slug="$(printf '%s' "$branch" | tr '/' '-' | tr -cd '[:alnum:]._-')"
  [ -n "$slug" ] || die "branch name '$branch' has no usable characters"
  path="$WORKTREE_ROOT/$slug"

  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository: $REPO_ROOT"
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch" && die "branch already exists: $branch"
  [ -e "$path" ] && die "path already exists: $path"

  git -C "$REPO_ROOT" fetch --quiet origin dev 2>/dev/null || warn "could not fetch origin/dev; branching from the local copy"
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE_REF" >/dev/null || die "base ref not found: $BASE_REF"

  mkdir -p "$WORKTREE_ROOT"
  git -C "$REPO_ROOT" worktree add -b "$branch" "$path" "$BASE_REF" >&2

  local f
  for f in "${LOCAL_FILES[@]}"; do
    if [ -f "$REPO_ROOT/$f" ]; then
      cp "$REPO_ROOT/$f" "$path/$f"
      log "copied $f"
    else
      warn "$f not found in the main checkout — the worktree may not run without it"
    fi
  done

  if [ "$DO_INSTALL" -eq 1 ]; then
    log "pnpm install…"
    ( cd "$path" && pnpm install --prefer-offline --frozen-lockfile >&2 ) \
      || warn "pnpm install failed — run it yourself in $path"
  fi

  printf '%s\n' "$path"
}

case "$MODE" in
  list)  list_sessions ;;
  prune) prune_sessions ;;
  print) create_session ;;
  launch)
    path="$(create_session)"
    log "session branch ready — launching claude in $path"
    cd "$path"
    exec claude ${CLAUDE_ARGS+"${CLAUDE_ARGS[@]}"}
    ;;
esac
