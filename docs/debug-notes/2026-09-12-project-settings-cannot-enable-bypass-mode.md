# A project settings file cannot put a session in bypass mode

**2026-09-12.** "new-session.sh still isn't using bypass mode by default." Every
document in the repo said it was: `CLAUDE.md` promised the launcher passes
`--dangerously-skip-permissions`, `.claude/settings.json` set
`permissions.defaultMode: "bypassPermissions"`, and the script's own comments
pointed at that key. The sessions prompted anyway.

Two things were wrong at once, and each one hid the other.

## The flag had been removed the day it was added

| Commit (all 2026-07-26) | What it did |
| --- | --- |
| `ad792d2` (#55) | added `--dangerously-skip-permissions` to the `exec claude` line |
| `dc013f1` (direct to `dev`, no PR) | removed it — bypass became opt-in via `-- --dangerously-skip-permissions` |
| `8cd67d1` (#56) | added `defaultMode: "bypassPermissions"` to `.claude/settings.json`; the message says "the launcher keeps its flag as well" — already untrue |
| `a77b7ad` (#57) | rewrote the script's comments to say bypass comes from settings.json |

So from #57 on, the launcher relied entirely on the settings key, while
`CLAUDE.md` kept describing a flag that no longer existed. Anyone who read the
docs concluded bypass was already on twice over and looked elsewhere.

## The settings key is a documented no-op at project scope

From code.claude.com/docs/en/permission-modes, "Which mode a session starts in":

> If you set `"bypassPermissions"` in `.claude/settings.json` or
> `.claude/settings.local.json`, it doesn't take effect either, and the session
> starts in Manual mode.

and, per scope: a project `.claude/settings.json` is honoured for "every value
except `auto` and `bypassPermissions`". Bypass can only come from
`~/.claude/settings.json`, managed settings, `--settings`, or a launch flag
(`--dangerously-skip-permissions` is documented as equivalent to
`--permission-mode bypassPermissions`). There is no error and no warning — the
session silently starts in Manual, which is exactly what was observed.

A first pass at the docs missed this (the settings-reference page lists
`defaultMode` as settable from "any file" and says nothing about the
per-value exception); the permission-modes page is where the rule lives.

## Fix

The launcher execs `claude --dangerously-skip-permissions …` again, the dead
key is gone from `.claude/settings.json`, and `CLAUDE.md` says which entry
points are covered: launcher sessions are; a plain `claude` in the main
checkout that moves in via `EnterWorktree` is not, unless the user sets
`defaultMode` in `~/.claude/settings.json` or launches with the flag.

## Rules

- **A launch flag is the only repo-owned way to start in bypass mode.** Do not
  move it back into `.claude/settings.json`; it will look configured and do
  nothing.
- **When a comment says a flag is passed, grep the `exec` line.** Two commit
  messages and a CLAUDE.md paragraph all described a flag that one unreviewed
  commit had removed.
- When a Claude Code setting "doesn't work", check the permission-modes page
  for per-scope exceptions before trusting the settings-reference scope column.
