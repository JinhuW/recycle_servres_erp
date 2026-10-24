---
id: RS-392
title: Never re-login Facebook unless necessary: the first rule in AGENTS.md
type: task
status: done
priority: P2
created: 2026-10-24
reporter: jinhu
branch: docs/never-relogin-facebook
pr: 870
version: n/a — docs only, no release
related: []
---

## Ask

> Keep in mind, never re-login facebook if it is not necessary.
> Write in the agent note as the most importatnt things

## Context

The owner said this mid-session on 2026-10-24. Restarting the city-queue
workers was on the table at the time, to start the day's round before its
13:00 UTC schedule.

Every Facebook login is a checkpoint risk. That day, 26 of the fleet's 41
accounts were parked on `SESSION_EXPIRED` or `CHECKPOINT`. The 15 healthy ones
had already booted twice overnight (00:02 and 00:50 UTC). Each boot shows in
`rsc vault logins` as `boot → restored`, which means a new browser restoring
the saved session.

No agent doc said that a container restart is a login. `trackers/facebook/AGENTS.md`
mentioned only the `relogin` route, in its contract list.

The rule goes at the top of the root `AGENTS.md` for two reasons:

- Every session loads that file through `CLAUDE.md`. That includes fleet-ops
  sessions that work over SSH and never open a file under `trackers/facebook/`,
  so the nested doc never loads for them.
- Any edit under `trackers/facebook/` would make dev's tree differ from the
  `facebook-tracker/v0.13.17` tag. `scripts/check-release-tag.sh` would then
  block `deploy.sh` until someone cut a tracker release.

## Acceptance criteria

- [x] The root `AGENTS.md` opens, before *Map*, with a section stating the rule
  and saying it comes first.
- [x] The section lists what counts as a login: a worker container start
  (restart, recreate, `deploy.sh`, `rsc fleet release`), the ERP's or console's
  Re-login, and deleting or replacing a saved session.
- [x] It says what to do instead: wait for the schedule, ship container changes
  in one deploy, and ask the owner before any restart or re-login a task does
  not strictly need.
- [x] It names the trap that tempts a restart: an idle monitor does not notice
  a host-side edit of its bind-mounted `config.toml`.

## Out of scope

- The same text in `trackers/facebook/AGENTS.md`. It can ride the next tracker
  release.
- Fixing the monitor's config watch. `doze()` in the vendored monitor's
  `utils.py` watches the config's directory. A host-side write to a
  single-file bind mount raises no event in that directory, so an idle worker
  never notices a config change. This was verified on 2026-10-24 with a
  throwaway container from the worker image.

## Notes

The trigger was the question of whether the 13:00 UTC round could start
early. The only way to make the idle monitors ask the queue sooner was a
restart. The round was left to start on schedule.
