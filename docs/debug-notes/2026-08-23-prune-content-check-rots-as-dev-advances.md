# "Is this branch merged?" via tip comparison rots as dev advances

**Date:** 2026-08-23
**Area:** tooling / `scripts/new-session.sh --prune` (`work_is_in_base`), and any merged-branch check
**Severity:** medium — prune silently reclaims (almost) nothing; worktrees accumulate at ~290 MB each

## Symptom

`scripts/new-session.sh --prune` reported 14 of 16 session worktrees as
`keep — work not yet in origin/dev` even though every one of them was the
exact head commit of a PR already squash-merged into `dev` (verified with
`gh pr list --state merged --head <branch> --json headRefOid`). Same failure
mode as the original ancestry bug
([2026-07-26](./2026-07-26-prune-ancestry-vs-squash-merge.md)): the safety
check is fail-safe, so nothing is ever destroyed — but nothing is ever
reclaimed either, which is the command's entire purpose.

## Cause

The content check compared every file the branch touched against the
**current tip** of `origin/dev`, byte for byte:

```bash
cmp -s <(git show "HEAD:$file") <(git show "$BASE_REF:$file") || return 1
```

That is only true in the window between this branch's merge and the next PR
that touches any of the same files. In this repo the window is hours at best,
because **every PR bumps the root `package.json` version** — so any session
branch that bumped it (i.e. all of them) mismatches dev's tip as soon as one
more PR lands, permanently. `CHANGELOG.md`, `i18n.tsx`, and hot route files
widen the blast radius. Two of the 14 false keeps mismatched *only* on
`package.json` — pure version-bump noise.

## Fix

Ask whether the branch's final content ever appeared in the base ref's
**history since the fork point**, not whether it matches the tip today. A
squash merge writes the branch's final blobs into dev verbatim, so those
blob objects are findable in the squash commit:

```bash
blob="$(git -C "$wt" rev-parse --verify --quiet "HEAD:$file")" || <deletion case>
[ "$blob" = "$(git rev-parse --verify --quiet "$BASE_REF:$file" || true)" ] && continue  # fast path
[ -n "$(git log -1 --format=%H --find-object="$blob" "$merge_base..$BASE_REF")" ] || return 1
```

Details that matter:

- **`git log --find-object`, not `git rev-list --find-object`.** At least
  through git 2.40 (macOS here), `rev-list` rejects `--find-object` with a
  usage error (exit 129) — it is a diff option and rev-list doesn't wire the
  diff machinery for it. Because every failure in this gate must read as
  "keep", the first version of this fix using rev-list silently changed
  nothing: every worktree still reported unmerged. The fail-safe hid the
  breakage — test the verdicts actually flip, not just that the script runs.

- **The range `merge_base..$BASE_REF` is load-bearing.** Searching all of
  dev's history would also match a branch that merely *reverted* a file to
  some ancient content — that blob exists in old history without this
  branch's work ever landing. Restricting to commits after the fork point
  means the content can only have arrived via (or after) this branch's merge.
- **Deleted files have no HEAD blob.** For those, the deletion landed iff
  the base no longer has the path (`git rev-parse --verify "$BASE_REF:$file"`
  fails).
- The fail-safe discipline from the 2026-07-26 note still applies: every git
  failure returns 1 (keep). `rev-list` failing → empty output → keep.

## What this check still cannot see

- A branch whose PR was merged **with conflict resolutions or edits on the
  GitHub side** produces a squash commit whose blobs differ from the local
  HEAD's. It stays `keep` — correct, since the local tree genuinely holds
  content dev doesn't have.
- A branch merged under a *different* head (e.g. re-pushed from another
  worktree) matches only if the final blobs coincide byte for byte.

## Rules of thumb

- **"Merged" checks in a squash-merge repo must compare against history,
  not the moving tip.** Any file that every PR touches (version fields,
  changelogs, lockfiles) makes tip comparison permanently false.
- When validating this kind of tooling, get ground truth from the forge:
  `gh pr list --state merged --head <branch> --json headRefOid` and compare
  with the worktree's HEAD. That is the test that exposed this.
