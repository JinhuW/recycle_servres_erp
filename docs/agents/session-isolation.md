# Agent sessions

Reached from the root `CLAUDE.md`.  Read this when a session worktree, lock
or prune behaves unexpectedly, or before changing `scripts/new-session.sh` /
`scripts/claude-session-hook.sh`.

## Session isolation (one branch per Claude Code session)

Several Claude Code sessions run against this repo at once, so **every session
works on its own branch inside its own git worktree**.  A single shared checkout
can only have one branch checked out; without this, a second session silently
switches the branch out from under the first.

- **Start sessions with `scripts/new-session.sh`.**  It branches off
  `origin/dev`, creates a worktree under `.claude/worktrees/`, copies the `.env` files
  (root, plus `trackers/reddit/.env` and `.api-token`),
  runs `pnpm install`, and launches `claude` inside it.  Optional branch name:
  `scripts/new-session.sh feat/<topic>` (default `session/<timestamp>`).
- **To pick work back up, `scripts/new-session.sh --checkout <branch>`.**  It
  puts an *existing* branch in a worktree instead of cutting a new one — local
  or remote-only (`origin/<branch>` is fetched and tracked, and either spelling
  is accepted).  The branch is taken as it stands: never rebased, never reset
  onto `origin/dev`.  If a session worktree already holds that branch, that
  worktree is handed back with its uncommitted work intact, unless a live
  session is still in it.  Because git allows a branch in only one worktree,
  a branch checked out in the main checkout is refused rather than stolen.
- **Launcher sessions run with permission prompts off** because
  `scripts/new-session.sh` execs `claude --dangerously-skip-permissions`.  That
  flag is the *only* repo-owned way in: Claude Code ignores a
  `permissions.defaultMode: "bypassPermissions"` set in a project-scope file
  (`.claude/settings.json` or `.claude/settings.local.json`) and starts the
  session in Manual mode — silently.  See
  [docs/debug-notes/2026-09-12-project-settings-cannot-enable-bypass-mode.md](../../docs/debug-notes/2026-09-12-project-settings-cannot-enable-bypass-mode.md).
  Don't put the key back.
- **A plain `claude` started in the main checkout keeps its prompts**, even
  after the `SessionStart` hook moves it into a worktree via `EnterWorktree`:
  permission mode is fixed at launch and `EnterWorktree` only changes the
  working directory.  To cover that path too, set `defaultMode` in
  `~/.claude/settings.json` (user scope is honoured) or launch with the flag.
- The worktree isolates the *branch*, not the machine: bypass mode still permits
  any shell command, any file outside the worktree, and pushes to any remote.
  To get prompts back, remove the flag from the `exec claude` line.
- **If a session starts in the main checkout anyway**, the `SessionStart` hook
  in `.claude/settings.json` (`scripts/claude-session-hook.sh`) says so.  The
  agent should then run `scripts/new-session.sh --print-only` and call
  `EnterWorktree` with the path it prints.  Read-only sessions — answering a
  question, reading history, no file edits — can skip this.
- The base ref is **always `origin/dev`, never `main`**, matching the normal
  branch workflow.  Claude Code's own `worktree.baseRef` setting can't express
  this (it only offers `origin/<default-branch>`, i.e. `main`, or local HEAD),
  which is why creation is scripted rather than left to `EnterWorktree`.
- **Worktrees are recycled, not accumulated.**  Starting a session reuses an
  idle slot (resetting it onto a fresh branch, keeping its `node_modules` so
  startup stays a few seconds) and sweeps any other idle slots, so abandoned
  sessions cannot pile up at ~290 MB each.  `--fresh` forces a new one.
- A slot counts as idle only if it is clean, on a branch, holds nothing that is
  not already in `origin/dev`, **no process has its working directory inside
  it**, **and** it carries a lock file from a session that has since exited.
  Locks live in `.claude/worktrees/.locks/` (outside the checkouts, so they
  don't show up as untracked files) and hold a claude PID: the launcher's
  (which `exec claude` inherits), or for `--print-only` the calling session's,
  found by walking up the process tree.  Only when no claude ancestor exists
  does `--print-only` fall back to a timestamp that expires after 8h.  The
  `SessionStart` hook re-records the PID whenever a session starts or resumes
  inside a slot, unless the lock names another live process.  Choosing a slot
  and writing its claim happen under a `mkdir` mutex
  (`.locks/.select`), so two launchers started together can't take the same
  slot (v1.196.1).  A worktree with **no** lock is never touched
  automatically — it predates the mechanism or was made by hand, so whether
  someone is sitting in it is unknowable.
- `scripts/new-session.sh --prune` reclaims idle slots on demand and `--list`
  shows each one's state without touching anything.  Prune keeps — never
  removes — a worktree that has uncommitted changes, is on a detached HEAD, is
  held by a live session, or that you are currently standing in.  It *will*
  remove a clean, fully-merged, unlocked worktree, so a session that was
  created outside the launcher should be given a lock file if you want it
  protected.
- **Prune compares file content against `origin/dev`'s history, not commit
  ancestry and not dev's tip.**  PRs land on `dev` as squash commits, so a
  session branch's own commits are never ancestors of `origin/dev`; an
  ancestry test (`git log origin/dev..HEAD`) would report every worktree as
  unmerged forever.  Comparing against dev's *tip* rots almost as fast:
  every PR bumps `package.json`, so any later merge makes an already-merged
  worktree mismatch permanently.  The check therefore looks for the branch's
  final blobs anywhere in `merge-base..origin/dev` (the squash commit carries
  them verbatim).  See
  [docs/debug-notes/2026-07-26-prune-ancestry-vs-squash-merge.md](../../docs/debug-notes/2026-07-26-prune-ancestry-vs-squash-merge.md)
  and
  [docs/debug-notes/2026-08-23-prune-content-check-rots-as-dev-advances.md](../../docs/debug-notes/2026-08-23-prune-content-check-rots-as-dev-advances.md).
- `.claude/` is gitignored **except** `settings.json`, `skills/` and
  `commands/`, so the hook config and the project's skills and commands are
  shared but worktrees and `settings.local.json` are not.
