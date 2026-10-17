# Merging a release PR deleted `dev`: auto-delete removes every PR's head branch

**Symptom.** Release PR #656 (`dev` → `main`) merged at 2026-10-17T00:27Z,
and `dev` disappeared from GitHub. Nothing looked wrong locally. The next
feature PR then failed to open:

```
$ gh pr create --base dev --head fix/fb-deploy-rsync-filter ...
pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be
blank, No commits between dev and fix/fb-deploy-rsync-filter, Base ref must be a
branch (createPullRequest)
```

Every worktree still showed `origin/dev` at the old SHA, because a plain
`git fetch` does not prune deleted remote branches.

## Root cause

RS-256 turned on the repo setting `delete_branch_on_merge`. GitHub applies it
to the head branch of every merged PR, and has no exception for long-lived
branches. A release PR's head is `dev`, so merging it deleted `dev`. `main` and
`prod` survived because branch protection already blocked their deletion.
`dev` had no protection.

## Fix

- Recreate `dev` at the release PR's head commit. Nothing is lost, because that
  commit is already in `main`:

  ```bash
  SHA=$(gh pr view 656 --json headRefOid --jq .headRefOid)
  git push origin "${SHA}:refs/heads/dev"
  ```

  In zsh, keep the braces. In `$SHA:refs/heads/dev`, zsh reads `:r` as a
  history modifier. It eats the `:r`, and the push targets a different ref.
- Protect `dev` against deletion and force-push. It needs no reviews and no
  required checks:

  ```bash
  gh api -X PUT repos/JinhuW/recycle_servres_erp/branches/dev/protection --input - <<'EOF'
  {"required_status_checks": null, "enforce_admins": true,
   "required_pull_request_reviews": null, "restrictions": null,
   "allow_deletions": false, "allow_force_pushes": false}
  EOF
  ```

## How not to hit it again

- While `delete_branch_on_merge` is on, protect any long-lived branch that is
  ever a PR's head. Today that means `dev`, `main` and `prod`.
- To check what exists on GitHub, run `git ls-remote --heads origin`. Local
  `origin/*` refs show what the last fetch saw, and a fetch without `--prune`
  never removes them.
