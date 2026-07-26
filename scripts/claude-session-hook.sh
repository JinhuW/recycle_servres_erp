#!/usr/bin/env bash
# claude-session-hook.sh — Claude Code SessionStart hook.
#
# Wired up in .claude/settings.json. Reads the hook payload on stdin and, when a
# brand-new session starts in the shared main checkout, tells Claude to move
# itself onto its own branch in its own worktree before touching any file.
#
# It only nudges; it does not create anything. Creating the worktree runs
# `pnpm install`, which is far too slow for a startup hook, so that is left to
# scripts/new-session.sh once the session is live.
#
# Stays silent (exit 0, no output) when there is nothing to do:
#   - source is resume/clear/compact — that session already has a branch
#   - cwd is already inside .claude/worktrees/ — already isolated
#
# Note: launching via `scripts/new-session.sh` skips all of this, because the
# session then starts inside the worktree already.

set -uo pipefail

payload="$(cat)"

# Never let a hook failure block a session from starting.
command -v jq >/dev/null 2>&1 || exit 0

source_kind="$(printf '%s' "$payload" | jq -r '.source // ""' 2>/dev/null || echo "")"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null || echo "")"

[ "$source_kind" = "startup" ] || exit 0

case "$cwd" in
  */.claude/worktrees/*) exit 0 ;;
esac

read -r -d '' CONTEXT <<'EOF' || true
This session started in the SHARED main checkout of recycle_servres_erp, which
several Claude Code sessions use at once. This project requires every session to
work on its own branch in its own git worktree, so concurrent sessions cannot
switch the branch out from under each other.

Before reading deeply into the codebase or editing any file, do this:

  1. Run: scripts/new-session.sh --print-only
     It creates a worktree on a fresh branch off origin/dev (never main),
     copies .env, runs pnpm install, and prints the worktree path.
     Give it a generous Bash timeout — the install takes a minute.
     Optionally pass a branch name: scripts/new-session.sh --print-only feat/<topic>
  2. Call the EnterWorktree tool with `path` set to the path it printed.

Then work normally; you are on a session-private branch off dev and can commit
and open a PR into dev as usual.

Skip both steps if the user explicitly asks to work in the main checkout, or if
the task is read-only (answering a question, inspecting history) and changes no
files.
EOF

jq -n --arg ctx "$CONTEXT" '{
  systemMessage: "This repo isolates each session: run scripts/new-session.sh --print-only, then EnterWorktree with that path. (Launching with scripts/new-session.sh does this for you.)",
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
