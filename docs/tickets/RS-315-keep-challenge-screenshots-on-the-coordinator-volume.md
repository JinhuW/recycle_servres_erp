---
id: RS-315
title: Keep challenge screenshots on the coordinator volume
type: bug
status: in-progress
priority: P2
created: 2026-10-19
reporter: jinhu
branch: fix/rs-315-screenshot-volume
pr:
version:
related: [RS-311, RS-286]
---

## Ask

> create a plan to fix them:
>
> Found on the way, not fixed
>
> - is_visible(timeout=…) is ignored by Playwright 1.64, so every such "wait" in poster/messenger/monitor is an instant snapshot.
> - Messenger's send check (get_by_text(...).last) may ack an unsent reply.
> - Challenge screenshots write outside the coordinator's data volume (RS_SCREENSHOT_DIR unset): none from past checkpoints survived.
> - Phase 2 candidate: a decision-model pre-screen in front of the listing LLM, after a shadow run against ai_eval history.

## Context

`rs_coordinator/rs_coordinator/escalation.py` writes challenge screenshots to
`RS_SCREENSHOT_DIR`, default `data/screenshots`, a relative path. Nothing sets
the variable (not the compose file, not the Dockerfile, not `secrets.env`), the
coordinator image's `WORKDIR` is `/app`, and the only volume is mounted at
`/data`. So the PNGs land in `/app/data/screenshots` in the container's own
filesystem, and `scripts/deploy.sh` (`up -d --build --force-recreate
coordinator`) throws them away on every deploy while the `challenges` rows in
Postgres keep a `screenshot_path` that then 404s. The compose file's own comment
on the volume says "Screenshots from escalated challenges"; nothing made it so.
Confirmed on the VM on 2026-10-19: no PNG anywhere in the container, `/data`
holds only an empty SQLite file.

Plan: `docs/superpowers/plans/2026-10-19-rs311-follow-ups.md`.

## Acceptance criteria

- [ ] With `RS_SCREENSHOT_DIR` unset, screenshots go to a `screenshots/` directory beside the database file (`RS_COORDINATOR_DB`), so the container writes under `/data` and a local run under the checkout's `data/`.
- [ ] The coordinator image and the compose file set `RS_SCREENSHOT_DIR=/data/screenshots` explicitly.
- [ ] `screenshot_path` is stored absolute.
- [ ] A challenge whose file is missing on disk lists `screenshot_url: null` instead of a URL that 404s.
- [ ] After deploy, `docker exec rs-coordinator sh -c 'echo $RS_SCREENSHOT_DIR; ls -ld /data/screenshots'` shows the volume path, and the next challenge's screenshot survives a redeploy.

## Out of scope

- Retention or pruning of screenshots: challenges are a few a week and a PNG is under a megabyte.
- Recovering past screenshots: they are gone.

## Notes

