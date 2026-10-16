---
id: RS-256
title: Clean up after the tracker migration
type: chore
status: in-progress
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

- [ ] The orca account-pool WIP is pushed verbatim to `wip/account-pool-writes-orca` (9 files, +813/−39) and RS-171 points at it.
- [ ] `trackers/reddit/.dockerignore` excludes `scripts/secrets.env` and `infra`; a fresh build's `scripts/` has no `secrets.env`.
- [ ] The dead laptop monitor plists and scripts are gone from `trackers/facebook/`; its README, CHANGELOG footer and AGENTS.md match the monorepo.
- [ ] `trackers/reddit/README.md` and `infra/README.md` describe the real API, config and deployment.
- [ ] No `facebook_tracker` / `reddits_tracker` / old-`CLAUDE.md` pointers remain in `apps/` or `docs/tickets/README.md`.
- [ ] The dead probe files in `docs/review-2026-10-13/` are deleted; `rollback/` is gitignored.
- [ ] The OCI fleet runs a clean image and every older GHCR version is purged.
- [ ] Local leftovers are deleted, `delete_branch_on_merge` is on, merged remote branches are deleted.

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
