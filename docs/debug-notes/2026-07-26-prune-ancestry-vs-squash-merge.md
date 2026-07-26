# "Is this branch merged?" via ancestry is always false under squash-merge

**Date:** 2026-07-26
**Area:** tooling / `scripts/new-session.sh --prune`, and any merged-branch check
**Severity:** medium — one form silently reclaims nothing, another silently destroys commits

## Symptom

`scripts/new-session.sh --prune` shipped with this check:

```bash
if [ -n "$branch" ] && [ -n "$(git -C "$path" log --oneline "$BASE_REF..$branch")" ]; then
  keep "commits not in $BASE_REF"
fi
```

It reported **every** session worktree as `keep — commits not in origin/dev`,
forever, and reclaimed nothing. At ~290 MB per worktree that is the entire
purpose of the command.

## Cause

Two independent defects in one condition.

**1. Ancestry is the wrong question in a squash-merge repo.** PRs land on `dev`
as a single squash commit (`3914571 fix(workspace,auth): … (#52)`). A squash
commit is a *new* commit with different parents, so the branch's original
commits never become ancestors of `origin/dev`. `git log origin/dev..HEAD`
therefore keeps listing them after the work is fully merged and shipped.
Confirmed in a scratch repo: after `git merge --squash` + commit, `git log
dev..feat` still lists both original commits.

**2. `[ -n "$branch" ] && …` skips the guard entirely on a detached HEAD.**
`symbolic-ref` returns empty when detached, so the compound test is false, no
`continue` runs, and control falls through to `git worktree remove`. That
command only refuses on modified/untracked files — it does not care about
unreachable commits. Reproduced against the real repo: a clean detached
worktree carrying a commit was removed without complaint. With no branch ref
holding it, that commit is unreachable.

So the same line was simultaneously too strict (normal branches: never pruned)
and too lax (detached: pruned even carrying work).

## Fix

Compare **content**, not ancestry, and evaluate `HEAD` rather than a branch name:

```bash
work_is_in_base() {
  local wt="$1" merge_base file
  merge_base="$(git -C "$wt" merge-base "$BASE_REF" HEAD)" || return 1
  [ "$merge_base" = "$(git -C "$wt" rev-parse HEAD)" ] && return 0
  while IFS= read -r file; do
    cmp -s <(git -C "$wt" show "HEAD:$file" 2>/dev/null || true) \
           <(git -C "$wt" show "$BASE_REF:$file" 2>/dev/null || true) || return 1
  done < <(git -C "$wt" diff --name-only "$merge_base" HEAD)
  return 0
}
```

Squash-merged work passes (the files match `dev` byte for byte), genuinely
unmerged work fails. Plus a hard refusal to auto-remove any detached-HEAD
worktree — a detached HEAD means something unusual is in flight (interrupted
rebase, bisect) and there is no ref keeping its commits alive.

## Rules of thumb

- **Never use `git log base..branch` or `git branch --merged` to decide whether
  it is safe to DELETE something in this repo.** Squash-merge makes both report
  "unmerged" indefinitely. They are fine for "show me what is new", not for
  "is it safe to discard".
- In a guard whose fallthrough is destructive, never write
  `[ -n "$maybe_empty" ] && [ <real test> ]`. An empty variable skips the real
  test and takes the destructive path. Test the empty case explicitly first.
- `git worktree remove` is not a safety net. It checks the working tree for
  modifications, not whether commits would be orphaned.
