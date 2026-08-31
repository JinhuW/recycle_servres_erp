# `die` inside `$( )` does not stop the script — it only ends its own subshell

**Date:** 2026-08-03
**Area:** tooling / `scripts/new-session.sh`, and any `set -e` bash script whose
functions return values via command substitution
**Severity:** medium — a fatal error prints, then execution continues with an
empty variable and fails somewhere unrelated

## Symptom

Adding `--checkout <branch>` to `scripts/new-session.sh`, a bad branch name
printed **two** errors, the second nonsensical:

```
$ scripts/new-session.sh --checkout feat/nope
error: no such branch: feat/nope (looked for a local branch and origin/feat/nope)
error: branch name '' has no usable characters
```

`die` had already run `exit 1`. The script kept going anyway, with `branch`
empty, and only stopped at an unrelated guard further down.

## Cause

The script returns values through stdout, so the call chain is two command
substitutions deep:

```bash
target="$(create_session)"                       # depth 1
  branch="$(resolve_branch "$CHECKOUT")"         # depth 2 — die lives in here
```

`die`'s `exit 1` terminates **the subshell it is running in** — the `$(…)` for
`resolve_branch` — and nothing more. `create_session` sees a failed assignment
and, under `set -e`, should exit… but does not, because **errexit is suppressed
inside a command substitution that is part of an assignment**. Minimal repro:

```bash
set -euo pipefail
inner() { echo "inner-die" >&2; exit 1; }
outer() { local v; v="$(inner)"; echo "STILL HERE" >&2; printf "out\n"; }
r="$(outer)"; echo "outer returned [$r]"
# inner-die / STILL HERE / outer returned [out] / exit=0
```

Note the last line: the failure does not even surface as a non-zero status,
because the substitution's status is that of the **last** command run in the
subshell — here the successful `printf`. So `r="$(outer)" || exit 1` would not
have caught it either.

This was latent in the script before `--checkout`. A `die` directly inside
`create_session` (depth 1) does end that subshell, so it looked like it worked —
but the top-level `target="$(create_session)"` still swallowed the status, and
the script only exited because the next command, `claim_worktree "$target"`,
happened to fail on the empty path. A downstream accident, not a guard.

## Fix

Make each depth's failure explicit, at the call site:

```bash
branch="$(resolve_branch "$CHECKOUT")" || exit 1   # inside create_session
...
target="$(create_session)" || exit 1               # top level
[ -n "$target" ] || exit 1
```

`|| exit 1` works here only because the failing command is the **last** one in
each subshell (`die` is the final statement on that path). Where it might not
be, the callee must be written so no successful command can run after the
failure — which `die`'s `exit` already guarantees.

## Rules of thumb

- **`set -e` is not in force inside `$(…)` used as an assignment RHS.** Do not
  rely on errexit to abort anything that runs inside a command substitution.
- **`exit` in a shell function is only as fatal as the subshell it runs in.** A
  `die` helper reads as "stop everything" and is not, the moment the function is
  called inside `$( )`.
- The exit status of `$(f)` is that of the **last command executed in `f`**, not
  of the first one that failed. A function that logs or prints after an error
  path reports success.
- Prefer `x="$(f)" || exit 1` over trusting errexit, and add `[ -n "$x" ]` where
  an empty value would be silently accepted downstream.
- Test the failure paths of a bash script, not just the happy ones. Both bugs
  here surfaced only by deliberately passing a nonexistent branch.
