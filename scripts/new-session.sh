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
#   scripts/new-session.sh --prune              # remove session worktrees whose work is in dev
#
# Flags:
#   --no-install     skip `pnpm install` in the new worktree
#   --base <ref>     branch from <ref> instead of origin/dev
#   -- <args...>     everything after `--` is passed through to `claude`
#
# What it does, in order:
#   1. Fetch the base ref (warn + fall back to the local copy if offline).
#   2. `git worktree add -b <branch> .claude/worktrees/<slug> <base>`.
#   3. Copy the gitignored local files a worktree needs to run (.env).
#   4. `pnpm install` inside it (hardlinks from the pnpm store, so it is cheap).
#   5. cd there and exec `claude`.
#
# Launched sessions keep permission prompts ON. The worktree isolates the
# branch, not the machine: bypass mode would still permit any shell command, any
# file outside the worktree, and pushes to any remote — so it is opt-in per
# invocation rather than the default:
#   scripts/new-session.sh -- --dangerously-skip-permissions
#
# Every session branches from origin/dev — never main — per the repo workflow.
# Worktrees live under .claude/worktrees/ and are gitignored.
#
# All progress output goes to stderr; the worktree path is the only thing
# written to stdout, so `--print-only` is safe to capture in a variable.

set -euo pipefail

# Where the caller invoked us from, captured before anything cd's.
INVOKED_FROM="$PWD"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the MAIN checkout, not merely the tree this script happens to sit in.
# A copy of this script exists inside every session worktree, and deriving the
# root from $BASH_SOURCE there would point .claude/worktrees/ at the worktree's
# own (empty) subdirectory, silently making --list/--prune no-ops. The common
# git dir is shared by every worktree and always resolves to the main checkout.
REPO_TOP="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || { printf 'error: not a git repository: %s\n' "$SCRIPT_DIR" >&2; exit 1; }
GIT_COMMON_DIR="$(cd -- "$REPO_TOP" && cd -- "$(git rev-parse --git-common-dir)" && pwd)"
REPO_ROOT="$(dirname -- "$GIT_COMMON_DIR")"

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

# Refresh whatever --base points at, rather than always origin/dev.
fetch_base() {
  case "$BASE_REF" in
    */*)
      local remote="${BASE_REF%%/*}" branch="${BASE_REF#*/}"
      if git -C "$REPO_ROOT" remote get-url "$remote" >/dev/null 2>&1; then
        git -C "$REPO_ROOT" fetch --quiet "$remote" "$branch" 2>/dev/null \
          || warn "could not fetch $BASE_REF; using the local copy"
      fi
      ;;
    *) : ;;  # a local ref — nothing to fetch
  esac
}

# Path of every worktree git currently knows about, one per line.
registered_worktrees() {
  git -C "$REPO_ROOT" worktree list --porcelain \
    | awk '/^worktree /{ print substr($0, 10) }'
}

# True when everything this worktree contains is already present in the base
# ref's content.
#
# Deliberately compares FILE CONTENT rather than commit ancestry: PRs land on
# dev as squash commits, so a session branch's own commits are never ancestors
# of origin/dev and an ancestry test (`git log base..HEAD`) reports "unmerged"
# forever — which would make --prune reclaim nothing, ever.
#
# Uses HEAD, not a branch name, so a DETACHED worktree carrying commits is
# still evaluated instead of falling through the check unexamined.
#
# Every git invocation here is checked: a FAILED command must never be read as
# "nothing changed, safe to delete". Returning 1 (keep) on any error is the only
# safe default for a function whose false answer deletes a directory.
work_is_in_base() {
  local wt="$1" merge_base head_sha changed file
  merge_base="$(git -C "$wt" merge-base "$BASE_REF" HEAD 2>/dev/null)" || return 1
  head_sha="$(git -C "$wt" rev-parse HEAD 2>/dev/null)" || return 1
  # No commits beyond the fork point at all.
  [ "$merge_base" = "$head_sha" ] && return 0
  # Captured into a variable rather than piped from a process substitution: in
  # `done < <(git …)` the exit status is invisible, so a git failure produces an
  # empty change set, the loop body never runs, and the function falls through
  # to `return 0` — reporting unmerged work as safe to delete.
  changed="$(git -C "$wt" diff --name-only "$merge_base" HEAD 2>/dev/null)" || return 1
  # Otherwise every file this worktree touched must match the base byte for byte.
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    cmp -s \
      <(git -C "$wt" show "HEAD:$file" 2>/dev/null || true) \
      <(git -C "$wt" show "$BASE_REF:$file" 2>/dev/null || true) \
      || return 1
  done <<< "$changed"
  return 0
}

# Echoes the porcelain status, or fails if git cannot report it at all. An
# unreadable status must not read as "clean".
worktree_status() {
  git -C "$1" status --porcelain 2>/dev/null
}

describe_state() {
  local wt="$1" dirty
  if ! dirty="$(worktree_status "$wt")"; then
    echo "cannot read git status"
  elif [ -n "$dirty" ]; then
    echo "uncommitted changes"
  elif ! work_is_in_base "$wt"; then
    echo "work not yet in $BASE_REF"
  else
    echo "clean — work is in $BASE_REF"
  fi
}

list_sessions() {
  local found=0 wt branch
  fetch_base
  while IFS= read -r wt; do
    case "$wt" in "$WORKTREE_ROOT"/*) ;; *) continue ;; esac
    found=1
    branch="$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '(detached)')"
    printf '  %-34s %-44s %s\n' "$(basename "$wt")" "$branch" "$(describe_state "$wt")" >&2
  done < <(registered_worktrees)
  [ "$found" -eq 1 ] || log "no session worktrees"
}

# Only ever removes worktrees that are BOTH clean and whose content is already
# in the base ref, so this cannot discard work. Anything else is reported and
# left alone.
prune_sessions() {
  fetch_base

  local removed=0 kept=0 wt branch dirty
  while IFS= read -r wt; do
    case "$wt" in "$WORKTREE_ROOT"/*) ;; *) continue ;; esac

    # Never yank the directory out from under the session running this command.
    case "$INVOKED_FROM" in
      "$wt"|"$wt"/*)
        log "keep   $(basename "$wt") — you are in it"; kept=$((kept + 1)); continue ;;
    esac

    if ! dirty="$(worktree_status "$wt")"; then
      log "keep   $(basename "$wt") — cannot read git status"; kept=$((kept + 1)); continue
    fi
    if [ -n "$dirty" ]; then
      log "keep   $(basename "$wt") — uncommitted changes"; kept=$((kept + 1)); continue
    fi
    # A detached HEAD means something unusual is in flight (interrupted rebase,
    # bisect, a hand checkout). There is no branch ref to keep its commits
    # reachable, so removing the worktree can orphan them. Never automate that.
    if ! git -C "$wt" symbolic-ref --quiet HEAD >/dev/null 2>&1; then
      log "keep   $(basename "$wt") — detached HEAD, remove by hand"; kept=$((kept + 1)); continue
    fi
    if ! work_is_in_base "$wt"; then
      log "keep   $(basename "$wt") — work not yet in $BASE_REF"; kept=$((kept + 1)); continue
    fi

    branch="$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    git -C "$REPO_ROOT" worktree remove "$wt"
    [ -n "$branch" ] && git -C "$REPO_ROOT" branch -D "$branch" >/dev/null
    log "remove $(basename "$wt")${branch:+ ($branch)}"
    removed=$((removed + 1))
  done < <(registered_worktrees)

  git -C "$REPO_ROOT" worktree prune
  log "removed $removed, kept $kept"
}

create_session() {
  local branch slug wt timestamp

  timestamp="$(date +%Y%m%d-%H%M%S)"
  branch="${NAME:-session/$timestamp}"
  # One directory per branch; '/' is not usable in a directory name here.
  slug="$(printf '%s' "$branch" | tr '/' '-' | tr -cd '[:alnum:]._-')"
  [ -n "$slug" ] || die "branch name '$branch' has no usable characters"
  wt="$WORKTREE_ROOT/$slug"

  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch" && die "branch already exists: $branch"
  [ -e "$wt" ] && die "path already exists: $wt"

  fetch_base
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE_REF" >/dev/null || die "base ref not found: $BASE_REF"

  mkdir -p "$WORKTREE_ROOT"
  git -C "$REPO_ROOT" worktree add -b "$branch" "$wt" "$BASE_REF" >&2

  local f
  for f in "${LOCAL_FILES[@]}"; do
    if [ -f "$REPO_ROOT/$f" ]; then
      cp "$REPO_ROOT/$f" "$wt/$f"
      log "copied $f"
    else
      warn "$f not found in the main checkout — the worktree may not run without it"
    fi
  done

  if [ "$DO_INSTALL" -eq 1 ]; then
    log "pnpm install…"
    ( cd "$wt" && pnpm install --prefer-offline --frozen-lockfile >&2 ) \
      || warn "pnpm install failed — run it yourself in $wt"
  fi

  printf '%s\n' "$wt"
}

case "$MODE" in
  list)  list_sessions ;;
  prune) prune_sessions ;;
  print) create_session ;;
  launch)
    target="$(create_session)"
    log "session branch ready — launching claude in $target"
    cd "$target"
    # Prompts stay on. The worktree isolates the BRANCH, not the machine —
    # bypass mode would still allow any shell command, any file outside this
    # directory, and pushes to any remote, so it is opted into per invocation:
    #   scripts/new-session.sh -- --dangerously-skip-permissions
    exec claude ${CLAUDE_ARGS+"${CLAUDE_ARGS[@]}"}
    ;;
esac
