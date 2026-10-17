---
id: RS-256
title: Clean up after the tracker migration
type: chore
status: done
priority: P2
created: 2026-10-16
reporter: jinhu
branch: chore/tracker-migration-cleanup
pr: 657
version: 1.259.1
related: [RS-255, RS-171]
---

## Ask

> based on the migration. Pls create an plan for clean up unsued files.

## Context

RS-255 (PRs #654/#655) moved `reddits_tracker` and `facebook_tracker` into
`trackers/`, archived the old GitHub repos and parked the local checkouts in
`recycle_servers/_archived/`. The move left behind duplicate checkouts, dead
Railway links, laptop-only scripts that no longer run, docs and comments that
name the old repos or the old monolithic `CLAUDE.md`, and a pile of merged
branches. Two findings come before any deletion: about 800 uncommitted lines of
RS-171 account-pool work in `~/orca/facebook_tracker`, and
`ghcr.io/jinhuw/reddits_tracker` images that bake in `scripts/secrets.env`
because `.dockerignore` never excluded it.

## Acceptance criteria

- [x] The orca account-pool WIP is pushed verbatim to `wip/account-pool-writes-orca` (9 files, +813/−39) and RS-171 points at it.
- [x] `trackers/reddit/.dockerignore` excludes `scripts/secrets.env` and `infra`; a fresh build's `scripts/` has no `secrets.env`.
- [x] The dead laptop monitor plists and scripts are gone from `trackers/facebook/`; its README, CHANGELOG footer and AGENTS.md match the monorepo.
- [x] `trackers/reddit/README.md` and `infra/README.md` describe the real API, config and deployment.
- [x] No `facebook_tracker` / `reddits_tracker` / old-`CLAUDE.md` pointers remain in `apps/` or `docs/tickets/README.md`.
- [x] The dead probe files in `docs/review-2026-10-13/` are deleted; `rollback/` is gitignored.
- [x] The OCI fleet runs a clean image and every older GHCR version is purged.
- [x] Local leftovers are deleted, `delete_branch_on_merge` is on, merged remote branches are deleted.

## Out of scope

Reconciling the orca account-pool writes with dev's newer `PUT /v1/accounts/{id}`
(RS-171 owns it). Renaming Railway Terraform resources (would change state).
Rotating the leaked secrets (a manual provider step for the owner).

## Notes

Plan: `~/.claude/plans/help-me-better-organizate-squishy-curry.md`, reviewed by a
subagent and approved 2026-10-16.

**RS-171 rescue.** The uncommitted account-pool writes from
`~/orca/facebook_tracker` (`feat/account-pool-writes`, base `9958051`) are on
branch `wip/account-pool-writes-orca` (`0a8beacd`, on `860276c5`, the
rewritten copy of the base): 9 files, +813/−39, byte-identical. They add
`POST`/`PATCH /v1/accounts`, and dev has since added `PUT /v1/accounts/{id}`,
so RS-171 must reconcile them before anything merges. The RS-171 ticket file
lives only on `feat/account-pool`, so this note is recorded here.

**Outcome (2026-10-16).**

- **Fleet image.** The OCI fleet runs `ghcr.io/jinhuw/reddits_tracker:4fb98ee9`
  (built from `4fb98ee9`, now also `:latest`); every worker heartbeats, and the
  running containers' `scripts/` has no `secrets.env`. The first deploy failed
  on every VM because `GHCR_READ_TOKEN` had died silently; the fleet stayed up
  on `29443d6`. A new read-only PAT fixed it. See
  `trackers/reddit/docs/debug-notes/ghcr-read-token-dead.md`.
- **Merged remote branches.** The 232 found by the survey were stale local
  refs: they had already been bulk-deleted on GitHub at 03:53 UTC that day.
  Only `chore/monorepo-trackers`, `docs/close-rs-255` and the stray
  `refs/remotes/pr575` and `pr/575` were left to delete. `feat/public-intake`
  stays, because it holds 2 commits (RS-095) that are not on dev.
- **Kept on purpose.** `.claude/worktrees/session-20260828-175116` looked
  orphaned, but it is the data directory of the running `recycle_pg`
  container, so it stays.
- **Root `.git` backup.** The workspace-root `.git` held an unreferenced
  commit with two files that existed nowhere else: an `order_lines` export
  and an old workspace `CLAUDE.md`. Both are saved in
  `recycle_servers/.root-dotgit-backup-20261016/`.
- **GHCR purge.** All 25 versions older than `4fb98ee9` are deleted. That
  includes `29443d6`, `9bca8ce` and `c72ce37`, and only the clean build's 5
  versions remain. The `gh` token needed the `delete:packages` scope for this.

**Found, not fixed here.**

- **`trackers/facebook/scripts/deploy.sh` can delete VM-only files.** It
  rsyncs `configs/` to the VM with `--delete`. From any checkout that lacks
  the VM-only `configs/secrets.homelab-*.env`, `accounts/`,
  `proxies.decodo.txt` and `generated/`, a deploy deletes them on the VM. A
  dry run on 2026-10-16 confirmed it.
- **The same rsync pushes gitignored login files.** It doesn't exclude
  `configs/account_info.txt*` or `configs/data.txt`, which hold Facebook logins
  and 2FA secrets, so a deploy from a dev checkout that has them copies them
  to the VM.
