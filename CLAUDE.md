@AGENTS.md

## Claude Code only

- **Skills** (`.claude/skills/`):
  - `ticket-workflow`: fires on any change request. It drafts the RS ticket in
    plan mode and closes it through `CHANGELOG.md` / `docs/FEATURES.md`.
    `/ticket` is the manual path.
  - `verify`: drives the local ERP stack end to end.
- **Sessions run in worktrees.** If a session starts in the main checkout, the
  `SessionStart` hook (`scripts/claude-session-hook.sh`) says so. Run
  `scripts/new-session.sh --print-only`, then `EnterWorktree` with the path it
  prints. Read-only sessions can stay put. When a worktree, lock or prune
  misbehaves, read
  [docs/agents/session-isolation.md](docs/agents/session-isolation.md).
- **Nested docs.** The `CLAUDE.md` files in `apps/backend/`, `apps/frontend/`,
  `trackers/reddit/` and `trackers/facebook/` each import their folder's
  `AGENTS.md`, and load when you read files there. ERP ops has no folder of its
  own; reach it through the pointer in *Pointers*.
