#!/usr/bin/env bash
# new-session.sh — start a Claude Code session on its own branch, in its own
# git worktree, so several sessions can run side by side without fighting over
# the single shared checkout.
#
# Usage:
#   scripts/new-session.sh                       # branch session/<timestamp>, then launch claude
#   scripts/new-session.sh feat/orders-filter    # explicit NEW branch name
#   scripts/new-session.sh --checkout feat/x     # resume an EXISTING branch
#   scripts/new-session.sh --print-only [name]   # create it, print the path, don't launch
#   scripts/new-session.sh --list                # show current session worktrees
#   scripts/new-session.sh --prune               # remove idle session worktrees
#
# Flags:
#   --checkout <br>  work on an existing branch instead of creating one. Takes
#                    `feat/x` or `origin/feat/x`; a branch that only exists on
#                    the remote is fetched and tracked. If a session worktree
#                    already has it checked out, that worktree is handed back
#                    as is — uncommitted work included.
#   --no-install     skip `pnpm install` in the new worktree
#   --fresh          force a brand-new worktree instead of reusing an idle one
#   --base <ref>     branch from <ref> instead of origin/dev (new branches only;
#                    with --checkout it only decides which slots count as idle)
#   -- <args...>     everything after `--` is passed through to `claude`
#
# Worktrees are RECYCLED, not accumulated. An idle slot — clean, on a branch,
# holding nothing that is not already in the base ref, and not held by a live
# session — is reset onto a fresh branch and handed over, keeping its
# node_modules so startup stays a few seconds. Any OTHER idle slots are swept at
# the same time. A new worktree is created only when none is idle.
#
# What it does, in order:
#   1. Fetch the base ref (warn + fall back to the local copy if offline).
#   2. Reuse an idle worktree, or `git worktree add -b <branch> … <base>`.
#      (--checkout instead adopts, or checks out, the branch you named.)
#   3. Sweep any remaining idle worktrees.
#   4. Copy the gitignored local files a worktree needs to run (.env).
#   5. `pnpm install` inside it (hardlinks from the pnpm store, so it is cheap).
#   6. cd there and exec `claude`.
#
# Permission prompts are off for this repo via permissions.defaultMode in
# .claude/settings.json, which applies to sessions started any way — not just
# this launcher. The worktree isolates the BRANCH, not the machine: that mode
# still permits any shell command, any file outside the worktree, and pushes to
# any remote.
#
# A NEW session branches from origin/dev — never main — per the repo workflow.
# --checkout takes the branch as it stands and does not rebase or reset it.
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
FORCE_FRESH=0
NAME=""
CHECKOUT=""
CLAUDE_ARGS=()

# Where in-use markers live. Deliberately OUTSIDE the worktrees themselves: a
# lock file inside a checkout would show up as an untracked file, making the
# worktree look dirty and therefore permanently non-reusable.
LOCK_DIR="$WORKTREE_ROOT/.locks"

# A worktree handed to a session that has not exited yet is considered live for
# this long, for the --print-only path where no PID is available to watch.
CLAIM_TTL_SECONDS=28800  # 8h

log()  { printf '  %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --print-only) MODE="print"; shift ;;
    --list)       MODE="list"; shift ;;
    --prune)      MODE="prune"; shift ;;
    --no-install) DO_INSTALL=0; shift ;;
    --fresh)      FORCE_FRESH=1; shift ;;
    --base)       [ $# -ge 2 ] || die "--base needs a ref"; BASE_REF="$2"; shift 2 ;;
    --checkout)   [ $# -ge 2 ] || die "--checkout needs a branch"; CHECKOUT="$2"; shift 2 ;;
    # Prints the whole leading comment block, so the help text cannot drift out
    # of a hardcoded line range as the header is edited.
    --help|-h)    awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' \
                    "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    --)           shift; CLAUDE_ARGS=("$@"); break ;;
    -*)           die "unknown flag: $1" ;;
    *)            [ -z "$NAME" ] || die "unexpected argument: $1"; NAME="$1"; shift ;;
  esac
done

# One names a branch to create, the other a branch that already exists; taking
# both would leave it ambiguous which one the session lands on.
[ -n "$CHECKOUT" ] && [ -n "$NAME" ] \
  && die "--checkout $CHECKOUT and the branch name '$NAME' are mutually exclusive"

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

# Path of the worktree that currently has <branch> checked out, empty if none.
# Git allows a branch in only one worktree at a time, so this is what decides
# whether --checkout can hand out a slot at all.
worktree_holding_branch() {
  git -C "$REPO_ROOT" worktree list --porcelain \
    | awk -v ref="refs/heads/$1" '
        /^worktree /{ wt = substr($0, 10) }
        $0 == "branch " ref { print wt; exit }'
}

# Echoes the local branch name for what the caller asked --checkout for, or
# dies. Accepts `feat/x` and `origin/feat/x` alike, and creates the local
# tracking branch when only the remote has it — resuming someone else's pushed
# branch is the main reason to reach for --checkout in the first place.
resolve_branch() {
  local want="$1" bare="$1" remote="origin" head
  case "$want" in
    */*) head="${want%%/*}"
         if git -C "$REPO_ROOT" remote get-url "$head" >/dev/null 2>&1; then
           remote="$head"; bare="${want#*/}"
         fi ;;
  esac

  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$want" \
    && { printf '%s\n' "$want"; return 0; }
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$bare" \
    && { printf '%s\n' "$bare"; return 0; }

  git -C "$REPO_ROOT" remote get-url "$remote" >/dev/null 2>&1 \
    || die "no such branch: $want"
  git -C "$REPO_ROOT" fetch --quiet "$remote" "$bare" 2>/dev/null || true
  git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/remotes/$remote/$bare" >/dev/null \
    || die "no such branch: $want (looked for a local branch and $remote/$bare)"

  git -C "$REPO_ROOT" branch --quiet --track "$bare" "$remote/$bare" >&2 \
    || die "could not create local branch $bare from $remote/$bare"
  log "created $bare tracking $remote/$bare"
  printf '%s\n' "$bare"
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

lock_file() { printf '%s/%s' "$LOCK_DIR" "$(basename "$1")"; }

# True while a session still holds this worktree.
#
# The launch path records the PID that `exec claude` inherits, so liveness is
# exact — `kill -0` on a dead session fails and the worktree frees itself. The
# --print-only path has no PID to record (the caller is an already-running
# session that will EnterWorktree into it), so it records a timestamp and the
# claim expires after CLAIM_TTL_SECONDS.
session_is_live() {
  local lock content age
  lock="$(lock_file "$1")"
  [ -f "$lock" ] || return 1
  content="$(cat "$lock" 2>/dev/null || true)"
  case "$content" in
    claimed:*)
      age=$(( $(date +%s) - ${content#claimed:} ))
      [ "$age" -lt "$CLAIM_TTL_SECONDS" ] ;;
    ''|*[!0-9]*) return 1 ;;
    *) kill -0 "$content" 2>/dev/null ;;
  esac
}

claim_worktree() { mkdir -p "$LOCK_DIR"; printf '%s\n' "$2" > "$(lock_file "$1")"; }

# Whether automation may take this worktree.
#
# Requires that THIS script handed it out (a lock exists) AND that session has
# since exited. A worktree with NO lock is off limits: it predates the lock
# mechanism or was made by hand, so whether someone is sitting in it is
# unknowable — and reuse (`checkout -B`) is just as disruptive to a live session
# as removal. Only the explicit --prune may touch those.
slot_is_free() {
  [ -f "$(lock_file "$1")" ] || return 1
  ! session_is_live "$1"
}

# First worktree that is safe to hand to a new session: clean, on a branch,
# carrying nothing that is not already in the base ref, not held by a live
# session, and not the one the caller is standing in.
reusable_worktree() {
  local wt dirty
  while IFS= read -r wt; do
    case "$wt" in "$WORKTREE_ROOT"/*) ;; *) continue ;; esac
    case "$INVOKED_FROM" in "$wt"|"$wt"/*) continue ;; esac
    slot_is_free "$wt" || continue
    dirty="$(worktree_status "$wt")" || continue   # unreadable — leave it alone
    [ -n "$dirty" ] && continue
    git -C "$wt" symbolic-ref --quiet HEAD >/dev/null 2>&1 || continue  # detached
    work_is_in_base "$wt" || continue
    printf '%s\n' "$wt"
    return 0
  done < <(registered_worktrees)
  return 1
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

    if session_is_live "$wt"; then
      log "keep   $(basename "$wt") — a session is using it"; kept=$((kept + 1)); continue
    fi

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
    rm -f "$(lock_file "$wt")"
    log "remove $(basename "$wt")${branch:+ ($branch)}"
    removed=$((removed + 1))
  done < <(registered_worktrees)

  git -C "$REPO_ROOT" worktree prune
  log "removed $removed, kept $kept"
}

provision_worktree() {
  local wt="$1" f
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
}

create_session() {
  local branch slug wt timestamp reused old_branch holder

  fetch_base

  if [ -n "$CHECKOUT" ]; then
    # `|| exit 1` is load-bearing: create_session already runs inside a command
    # substitution, so a die() in resolve_branch kills only its own subshell and
    # this function would otherwise carry on with an empty branch name.
    branch="$(resolve_branch "$CHECKOUT")" || exit 1
  else
    timestamp="$(date +%Y%m%d-%H%M%S)"
    branch="${NAME:-session/$timestamp}"
    git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch" \
      && die "branch already exists: $branch — use --checkout $branch to work on it"
    git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE_REF" >/dev/null || die "base ref not found: $BASE_REF"
  fi

  # One directory per branch; '/' is not usable in a directory name here.
  slug="$(printf '%s' "$branch" | tr '/' '-' | tr -cd '[:alnum:]._-')"
  [ -n "$slug" ] || die "branch name '$branch' has no usable characters"

  # A branch lives in at most one worktree, so an existing checkout of it has to
  # be resolved before anything else — git would simply refuse a second one.
  # Handing that worktree back is also the behaviour you want: it is where the
  # branch's uncommitted work is.
  if [ -n "$CHECKOUT" ]; then
    holder="$(worktree_holding_branch "$branch")"
    if [ -n "$holder" ]; then
      case "$holder" in
        "$WORKTREE_ROOT"/*) ;;
        *) die "$branch is checked out at $holder — switch it away, or work there directly" ;;
      esac
      ! session_is_live "$holder" \
        || die "$branch is in use by a session at $holder (if that session is gone: rm $(lock_file "$holder"))"
      log "adopting $(basename "$holder") — already on $branch"
      reap_idle_except "$holder"
      provision_worktree "$holder"
      printf '%s\n' "$holder"
      return 0
    fi
  fi

  # Prefer an idle worktree over a new one: each costs ~290 MB and a pnpm
  # install, and an abandoned session leaves one behind every time. Directory
  # names are just slots — the BRANCH is what identifies a session, so a reused
  # slot keeps its original directory name and gets a fresh branch.
  if [ "$FORCE_FRESH" -eq 0 ] && reused="$(reusable_worktree)"; then
    wt="$reused"
    old_branch="$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    log "reusing $(basename "$wt") — nothing in it${old_branch:+ (was $old_branch)}"
    if [ -n "$CHECKOUT" ]; then
      # Plain checkout, never `-B`: the branch already carries work, and
      # resetting it onto the base ref would throw that work away.
      git -C "$wt" checkout -q "$branch"
    else
      # Safe: reusable_worktree already proved the tree is clean and carries
      # nothing that is not already in the base ref.
      git -C "$wt" checkout -q -B "$branch" "$BASE_REF"
    fi
    if [ -n "$old_branch" ] && [ "$old_branch" != "$branch" ]; then
      case "$old_branch" in
        session/*) git -C "$REPO_ROOT" branch -D "$old_branch" >/dev/null 2>&1 || true ;;
      esac
    fi
  else
    wt="$WORKTREE_ROOT/$slug"
    [ -e "$wt" ] && die "path already exists: $wt"
    mkdir -p "$WORKTREE_ROOT"
    if [ -n "$CHECKOUT" ]; then
      git -C "$REPO_ROOT" worktree add "$wt" "$branch" >&2
    else
      git -C "$REPO_ROOT" worktree add -b "$branch" "$wt" "$BASE_REF" >&2
    fi
  fi

  # One idle slot is enough to keep around; sweep any others so abandoned
  # sessions cannot accumulate at ~290 MB each.
  reap_idle_except "$wt"

  provision_worktree "$wt"
  printf '%s\n' "$wt"
}

# Removes every idle worktree except the one passed in. "Idle" is the same bar
# --prune uses, so this can no more discard work than --prune can.
reap_idle_except() {
  local keep="$1" wt dirty branch reaped=0
  while IFS= read -r wt; do
    case "$wt" in "$WORKTREE_ROOT"/*) ;; *) continue ;; esac
    [ "$wt" = "$keep" ] && continue
    case "$INVOKED_FROM" in "$wt"|"$wt"/*) continue ;; esac
    slot_is_free "$wt" || continue
    dirty="$(worktree_status "$wt")" || continue
    [ -n "$dirty" ] && continue
    git -C "$wt" symbolic-ref --quiet HEAD >/dev/null 2>&1 || continue
    work_is_in_base "$wt" || continue

    branch="$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    if git -C "$REPO_ROOT" worktree remove "$wt" 2>/dev/null; then
      [ -n "$branch" ] && git -C "$REPO_ROOT" branch -D "$branch" >/dev/null 2>&1
      rm -f "$(lock_file "$wt")"
      reaped=$((reaped + 1))
    fi
  done < <(registered_worktrees)
  [ "$reaped" -gt 0 ] && log "swept $reaped idle worktree(s)"
  return 0
}

case "$MODE" in
  list)  list_sessions ;;
  prune) prune_sessions ;;
  print)
    target="$(create_session)" || exit 1
    [ -n "$target" ] || exit 1
    # No PID to watch — the caller is an already-running session that will
    # EnterWorktree into this path — so the claim expires on a timer instead.
    claim_worktree "$target" "claimed:$(date +%s)"
    printf '%s\n' "$target"
    ;;
  launch)
    target="$(create_session)" || exit 1
    [ -n "$target" ] || exit 1
    log "session branch ready — launching claude in $target"
    cd "$target"
    # `exec` keeps this PID, so the lock names the claude process itself and the
    # slot frees automatically when that session exits.
    claim_worktree "$target" "$$"
    # Permission prompts are off for this repo via permissions.defaultMode in
    # .claude/settings.json, which covers sessions started any way — not just
    # this launcher. The worktree isolates the BRANCH, not the machine.
    exec claude ${CLAUDE_ARGS+"${CLAUDE_ARGS[@]}"}
    ;;
esac
