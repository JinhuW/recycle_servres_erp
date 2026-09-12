---
id: RS-042
title: new-session.sh launches without bypass mode
type: bug
status: done
priority: P2
created: 2026-09-12
reporter: Jinhu
branch: session/20260912-170458
pr: 307
version:
related: []
---

## Ask

> fix scripts/new-session.sh, It still not using the by pass mode by default

> i hope it can bypass permission.

## Context

`CLAUDE.md` says the launcher passes `--dangerously-skip-permissions` when it
execs `claude`. It does not: #55 (`ad792d2`) added the flag, `dc013f1` removed
it the same day, and #56 (`8cd67d1`) moved bypass into
`.claude/settings.json` as `permissions.defaultMode: "bypassPermissions"`
while claiming the launcher "keeps its flag as well".

Per the Claude Code docs (permission-modes, "Which mode a session starts in"),
a `bypassPermissions` value in `.claude/settings.json` or
`.claude/settings.local.json` does not take effect — the session starts in
Manual mode. Only `~/.claude/settings.json`, managed settings, or a launch
flag can enable it. So every launcher-started session has prompted since
2026-07-26, and every document in the repo said it should not.

## Acceptance criteria

- [x] `scripts/new-session.sh` execs `claude --dangerously-skip-permissions …`.
- [x] Extra args after `--` still pass through.
- [x] The dead `permissions.defaultMode` key is gone from `.claude/settings.json`.
- [x] Script header, exec-site comment and `CLAUDE.md` state the real rule.
- [x] A debug note records the trap.

## Out of scope

- Bypass for a plain `claude` started in the main checkout (the SessionStart
  hook + `EnterWorktree` path). Repo config cannot do it; a user who wants it
  sets `permissions.defaultMode` in `~/.claude/settings.json` or launches with
  the flag. Documented in `CLAUDE.md`, not automated.
- An opt-out flag on the launcher. Removing the flag from the `exec` line is
  the opt-out, as #55 said.

## Notes

- `scripts/`, `.claude/`, `CLAUDE.md` and `docs/` are outside the
  version-check path filter, so no version bump or changelog section.
- Debug note: `docs/debug-notes/2026-09-12-project-settings-cannot-enable-bypass-mode.md`.
