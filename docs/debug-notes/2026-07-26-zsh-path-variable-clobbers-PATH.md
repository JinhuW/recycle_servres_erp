# In zsh, `path=$(...)` destroys `PATH` for the rest of the shell

**Date:** 2026-07-26
**Area:** shell / testing `scripts/*.sh` from an agent Bash tool
**Severity:** low (no data loss) but very confusing — it looks like the script broke

## Symptom

While smoke-testing `scripts/new-session.sh`, this test snippet:

```bash
path=$(./scripts/new-session.sh --print-only --no-install smoke/worktree-test)
echo "branch: $(git -C "$path" symbolic-ref --short HEAD)"
```

produced:

```
(eval):7: command not found: git
(eval):8: command not found: git
(eval):10: command not found: wc
(eval):10: command not found: tr
env: bash: No such file or directory
```

Every external command vanished mid-script. The obvious (wrong) conclusion is
that the script under test corrupted the environment — it did not. The script
had already succeeded: it printed the worktree path correctly on the line above.

## Cause

The Bash tool runs **zsh** here. In zsh, `path` is a special parameter tied to
`PATH` (like `fpath`/`cdpath`): it is normally an *array* of directories, and
assigning a plain string to it rewrites `PATH` to that single value. So

```zsh
path=/Users/.../.claude/worktrees/smoke-worktree-test
```

set `PATH` to one nonexistent-as-a-bin-dir path, and every later `git`, `wc`,
`tr`, and even `env bash` lookup failed. Bash has no such binding, so the same
snippet is harmless in bash — which is exactly why it is easy to hit.

## Fix / how to avoid it

- **Never name a shell variable `path` in zsh.** Use `wt`, `dir`, `target`,
  `out`, etc. The other tied names to avoid: `cdpath`, `fpath`, `manpath`,
  `PATH`-adjacent lowercase forms generally.
- Inside scripts this is not a risk in practice: `scripts/*.sh` start with
  `#!/usr/bin/env bash` and run under bash. The trap only bites **ad-hoc test
  commands typed at the zsh prompt / through the agent Bash tool.**
- Symptom-to-cause shortcut: if a batch of unrelated commands suddenly report
  `command not found` partway through a shell snippet, suspect a clobbered
  `PATH` from a lowercase special-variable assignment, not the program you were
  testing. `echo $PATH` confirms it instantly.
