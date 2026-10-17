---
id: RS-255
title: Fold reddits_tracker and facebook_tracker into this repo; AGENTS.md per area
type: task
status: done
priority: P2
created: 2026-10-16
reporter: jinhu
branch: chore/monorepo-trackers
pr: 654
version: n/a — imported trackers, docs and CI only, no ERP release
related: [RS-048, RS-164, RS-165, RS-170]
---

## Ask

> help me better organizate my repo.
>
> @reddits_tracker . @facebook_tracker @recycle_servres_erp/
>
> These 3 repo are serving the same service in the @recycle_servres_erp
>
> I would like to create an mono repo to better organizate them. pls update the agent.md to faciliate them use ai better.

## Context

The ERP already drives both listing monitors over HTTP. The backend proxies
`/api/tracker/*` (`apps/backend/src/routes/tracker.ts`) to the reddits_tracker
admin API. It proxies `/api/coordinator/*` (`routes/coordinator.ts`) plus the
noVNC relay (`vncBridge.ts`) to facebook_tracker's rs_console facade. The
desktop "Monitors ▸ Reddit / Facebook" pages sit on top of those proxies. The
code lived in three separate GitHub repos, so a change to one side of a
contract could not land with the other.

The AI docs had drifted:

- The ERP `CLAUDE.md` was 528 lines of ERP-only detail that loaded for every
  task.
- reddits_tracker's `CLAUDE.md` was missing its deploy path and the ERP
  contract.
- facebook_tracker had no agent doc.
- The workspace-level `CLAUDE.md` still called facebook_tracker an empty
  placeholder.

The user chose the following:

- Fold the trackers into this repo, with history.
- Make `AGENTS.md` the source of truth, with `CLAUDE.md` shims that import it.
- Keep the reddit tracker as a standalone pnpm project outside the root
  workspace.
- Split the ERP doc by area.
- Archive the old repos.

## Acceptance criteria

- [x] `trackers/reddit/` and `trackers/facebook/` are present with their full
      commit history. facebook_tracker's tags are imported as
      `facebook-tracker/v*`.
- [x] No `tf.plan`, `proxies.decodo.txt`, `ai-marketplace-monitor/` blob or
      proxy credential string is reachable in this repo's history.
- [x] The reddit tracker's `pnpm typecheck`, `pnpm test` and `docker build`
      pass from `trackers/reddit/`.
- [x] facebook_tracker's release-gate and secret-scan tests pass in the nested
      layout. Tags are prefixed and scans are scoped to `trackers/facebook/`.
- [x] The root `pnpm-lock.yaml`, workspace and CI triggers are unchanged. Only
      `version-check` runs on the PR.
- [x] Every heading of the old root `CLAUDE.md` lands in exactly one new doc,
      and every relative link in the new docs resolves.
- [x] The old GitHub repos are archived with a "moved" banner.

## Out of scope

- Joining the reddit tracker to the root pnpm workspace.
- Sharing API types between the ERP proxies and the trackers.
- CI workflows for the trackers. Neither tracker had any before this change.
- Renaming the repo (the `servres` typo).
- Fixing drift in the ERP README and deployment docs. Only pointers into the
  old `CLAUDE.md` are updated.

## Notes

- **History is imported with `git filter-repo`.** It runs in one pass per
  tracker: drop secret-bearing paths, redact the proxy credential, move into
  the subdirectory, and prefix the tags. That run rewrote every commit hash, so
  hashes cited before 2026-10-16 (for example in `CHANGELOG.md`) resolve only
  in the archived repos.
- **The proxy credential must still be rotated.** It remains in the archived
  facebook_tracker repo's history.
- **The PR has to merge with a merge commit, not a squash.** A squash would
  collapse the imported history into a single commit.
- **Shipped in #654** (merge commit `a08b8916`; facebook tags pushed as
  `facebook-tracker/v0.2.0…v0.5.5`). Then:
  - the old GitHub repos were archived with a "moved" banner;
  - the local checkouts went to `recycle_servers/_archived/`;
  - `trackers/reddit` was re-linked to Railway `reddits-tracker` (production).
- **Deviation from the plan: CI.** The per-area docs under `apps/` would have
  counted as ERP code. So `version-check`, `backend-tests` and
  `deploy-frontend` now ignore `*.md`.
- **Found, not fixed (needs its own tickets):**
  - `check-secrets.sh --all` false-positives on `fleet.js:16` / `vnc.js:13`,
    which blocks the next facebook release until they carry
    `pragma: allowlist secret`.
  - `rs_coordinator/routers/session.py` `backup_session` accepts the fleet-wide
    token with a client-chosen `worker_id`.
