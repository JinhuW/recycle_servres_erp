# A forked code review switched the session's branch under it: fixes were written on the wrong base

**Symptom.** During the v1.238 release, `/code-review high 578` ran as a
forked background agent in the session's worktree. Meanwhile the session cut
`fix/prerelease-rs220` off `origin/dev` and started on RS-220's fixes. Nothing
looked wrong: the edits applied, typecheck was clean, and 2170 backend tests
passed. Then the review's report said in passing: "I briefly switched this
worktree to a detached checkout of 6e3a0ab1, then switched it straight back to
`dev-11`."

`git reflog` showed what had happened:

```
19:39:37  checkout: moving from dev-11 to fix/prerelease-rs220    ← the session
19:40:27  checkout: moving from fix/prerelease-rs220 to 6e3a0ab1   ← the fork
19:40:34  checkout: moving from 6e3a0ab1 to dev-11                 ← the fork "restoring"
```

The worktree was on `dev-11` (e5222f69, before RS-218), not on the fix branch
(506f439c, with RS-218). Every code edit and test run after 19:40 had been
made against code without the PR under review. Uncommitted changes carry
across a checkout, so nothing visibly broke. The only hint was an Edit
tool's "the file had been modified on disk since you last read it", which
looked like ordinary noise.

## Root cause

A forked skill shares the parent's working directory. The review checked out
the PR's commit to read it, then "restored" the branch it had seen when it
started, which was `dev-11`. It knew nothing of the switch the parent made
after it launched. Two agents moving HEAD in one worktree is a race. The loser
doesn't get an error: its edits land on whatever HEAD is.

## Fix

- Commit the work on the branch it landed on, as a WIP commit, then switch to
  the intended branch and `git cherry-pick` it. RS-220's diff picked cleanly
  onto `origin/dev`.
- Put the stray branch back with `git branch -f dev-11 e5222f69`.
- Re-run typecheck and the suite on the right base.

## How not to hit it again

- Run `git branch --show-current` and `git log --oneline -1` before the
  first edit after launching a background review or other fork, and again
  before committing.
- A review should read a commit with `git show <sha>:<path>` or
  `git worktree add` into the scratchpad, never by checking out in the
  session's worktree.
- Treat "the file had been modified on disk since you last read it", on a file
  you didn't touch since the last read, as a sign HEAD may have moved.
