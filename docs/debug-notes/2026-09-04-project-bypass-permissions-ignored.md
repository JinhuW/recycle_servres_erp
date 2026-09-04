# Permission prompts came back with no repo change: the CLI stopped honouring project settings

**2026-09-04.** Sessions started by `scripts/new-session.sh` began asking for
permission again. Nothing in the repo had changed —
`.claude/settings.json` still carried
`permissions.defaultMode: "bypassPermissions"`, and that file had been the
mechanism since #56.

The change was on the machine, not in the checkout. **From Claude Code 2.1.257,
`defaultMode: bypassPermissions` (and `auto`) is ignored when it comes from
project or local settings** — only user or managed settings, or a launch flag,
still set it. Before 2.1.257 any settings file worked, which is why the repo
was written to rely on one.

## What made it hard to see

**Two CLIs are installed and they disagree.** `which -a claude` shows
`/opt/homebrew/bin/claude` (2.0.31) and `~/.local/bin/claude` (2.1.260, updated
2026-09-03). The interactive `PATH` puts `~/.local/bin` first, so a real session
runs 2.1.260 and prompts — while a quick `claude --version` from a tool shell
that resolves Homebrew first reports 2.0.31, where the settings file still
works. Check *which* binary an interactive shell picks before concluding the
setting is fine.

**The failure is silent.** An ignored `defaultMode` produces no warning, no log
line, and no diff — just prompts that were not there yesterday.

## The fix

`scripts/new-session.sh` execs `claude --dangerously-skip-permissions` again
(it did until `dc013f1`, which made it opt-in). A flag is version-independent.

`.claude/settings.json` keeps its `defaultMode` — inert on a current CLI,
still effective on an older one.

**`EnterWorktree` sessions are deliberately not covered.** The `--print-only`
path never execs `claude`, and permission mode is fixed at launch, so a session
that starts in the main checkout and moves into a worktree keeps its prompts.
Covering it would mean a `defaultMode` in `~/.claude/settings.json`, which
applies to every project on the machine — a machine-wide decision, not a repo
one.
