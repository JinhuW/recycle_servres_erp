---
id: RS-258
title: Facebook deploy must not delete VM-only files or push dev-only logins
type: bug
status: in-progress
priority: P2
created: 2026-10-16
reporter: jinhu
branch: fix/fb-deploy-rsync-filter
pr:
version:
related: [RS-256]
---

## Ask

> pls complete all remaining

## Context

Found during RS-256 and recorded under that ticket's "Found, not fixed here"
notes. `trackers/facebook/scripts/deploy.sh` syncs the tree to the homelab VM
with `rsync --delete`. Its exclude list covered only `configs/secrets.env` and
`configs/sessions`, which caused three problems:

- **It deletes files that exist only on the VM.** From any checkout that lacks
  them, a deploy deletes the VM's hand-written per-worker tokens
  (`configs/secrets.homelab-*.env`), the `secrets.env.bak-*` backups,
  `proxies.decodo.txt`, `accounts/` and `generated/`. A dry run on 2026-10-16
  confirmed it.
- **It pushes dev-only login files.** `configs/account_info.txt*` holds Facebook
  logins and 2FA secrets that only `rs_poster/session_cli.py` reads, on dev. It
  and `configs/data.txt` were copied to the VM by any deploy from a checkout
  that had them.
- **It overwrites VM-owned secrets.** A dev checkout's stale copy of a
  VM-owned file replaced the live one.

Nothing on the VM mounts `configs/generated/` (checked with `docker inspect`),
so excluding it is safe.

## Acceptance criteria

`scripts/tests/test-deploy-filter.sh` proves each of these by running rsync
with the shared filter file from a fake dev tree into a fake VM tree:

- [ ] VM-only files survive a deploy from a checkout that lacks them:
      `configs/secrets.homelab-x.env`, `configs/secrets.env.bak-1`,
      `configs/proxies.decodo.txt`, `configs/accounts/` with its contents, and
      `configs/generated/w.toml`.
- [ ] A dev copy never overwrites a VM-owned file: `secrets.homelab-y.env`,
      `proxies.decodo.txt` and `generated/z.toml` keep the VM's content.
- [ ] Dev-only files never reach the VM: `configs/account_info.txt`,
      `configs/account_info.txt.bak` and `configs/data.txt`.
- [ ] The old rules still hold: `configs/secrets.env` and `configs/sessions/`
      are neither sent nor deleted, `logs/` and `data/` are not sent, and
      `*.png` is not sent.
- [ ] A normal sync still works: the tracked `configs/secrets.env.example` and
      `configs/master.toml` arrive with dev's content, and a file removed on
      dev (`scripts/old.sh`) is deleted on the VM.
- [ ] `deploy.sh` reads its rules from `scripts/deploy.rsync-filter`, and
      `release.sh` runs the new test.

## Out of scope

- Cutting a facebook-tracker release or deploying to the VM. The VM tree is a
  hand-edited checkout of the archived repo, stamped `0.5.5+unreleased-relogin`.
- Latent issues, recorded here and not fixed:
  - The Matrix bridge configs and database, and `rs_poster/ads/state.json`,
    would also be deleted by `--delete` once they exist on the VM.
  - The `data` exclude is unanchored, so it matches every path component
    named `data`.
  - The `*.png` exclude blocks the tracked
    `rs_console/rs_console/static/recycle-servers-icon.png`.
  - `rs_router/` is not in the sync list.
  - The Mini and the VM hold stale `configs/generated/` shards (`release.sh`
    reports DRIFT).

## Notes

**Test first.** `scripts/deploy.rsync-filter` started out holding only the
old inline excludes. A run of the old inline flags gave the same result. With
those rules the new test failed 11 checks: every VM-only file was deleted,
every stale dev copy replaced the VM's, and all three dev-only files were sent.
With the anchored rules added, all 24 checks pass. Moving the
`+ /configs/secrets.env.example` line below the `secrets.env.*` exclude fails
the "secrets.env.example arrives" check, so the test also pins the order.

**Dry run against the VM (2026-10-16).** The run used `rsync -n` from a Mac
worktree that lacks every VM-only file. The old excludes would delete
`configs/generated/` with its six worker shards, `accounts/`, five
`secrets.homelab-*.env`, `secrets.env.bak-20261004-045221` and
`proxies.decodo.txt`. The new filter deletes nothing under `configs/`. The only
deletions left are the four laptop-monitor files that RS-256 removed
(`deploy/com.recycleservers.fbmonitor*.plist`, `scripts/watchdog.sh`,
`scripts/run-monitor.sh`). Apart from deletions, both runs list the same
changes.

**Found, not fixed here.** `scripts/check-secrets.sh --all` already fails on
dev. It flags `const TOKEN_KEY = 'rs-console-token'` in
`rs_console/rs_console/static/fleet.js` and `vnc.js`. Those are localStorage
key names, not secrets, but `release.sh` stops at its first gate until they
carry `pragma: allowlist secret`.
