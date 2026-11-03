---
id: RS-513
title: Fleet: staged worker image and one-account CloakBrowser canary
type: story
status: done
priority: P2
created: 2026-11-02
reporter: jinhu
branch: cloak-staged-canary
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1066, https://github.com/JinhuW/recycle_servres_erp/pull/1068
version: 1.412.1
related: [RS-505, RS-507]
---

## Ask

> I would like to deploy the worker in the homlab server. upload the secret for me.
> export CLOAKBROWSER_LICENSE_KEY=[license key redacted]
>
> 2. This is a experiment change, so let we start with one account and see how it works.

Follow-up answers: a staged image plus one extra worker; the key as its own
Worker secret; "let we test in the dev"; a never-claimed account picked by the
agent.

## Context

A fleet release replaces every running worker, one Facebook login each. A
one-account CloakBrowser canary needs exactly one worker on the 0.16.0 image
while the others keep running, and that worker has to take the cloak account.
The license key was meant to ride in `FLEET_WORKER_ENV`, but that secret can't
be read back, and rebuilding it risks every worker's next start. Testing runs
on dev (`inventory-dev`, host `worker-60-14`) before the homelab, which is a
prod host.

**No dev fleet.** Since RS-427 (2026-10-27) both worker-60-14 and the
homelab claim from the prod ERP; inventory-dev mirrors prod's fleet
read-only and forwards worker calls to prod. So the owner chose to test on
prod with one never-claimed account, through a dev → main release.

## Acceptance criteria

- [x] `POST /api/fleet/releases` with `staged: true` records a release in
      state `staged`. New containers start on its image, and no running worker
      is replaced. A later ordinary release supersedes it.
- [x] A worker new enough for CloakBrowser takes a free cloak slot before a
      free stock one. Its own previous slot still comes first.
- [x] The Cloudflare Worker adds the `CLOAKBROWSER_LICENSE_KEY` secret to a
      claim's `env` only when the claimed device's engine is `cloak`. A stock
      claim never carries it, and `FLEET_WORKER_ENV` is unchanged.
- [x] The fleet page shows a staged release.

## Out of scope

Rolling the whole fleet onto 0.16.0, the homelab and prod canary (after dev),
the fonts licence.

## Notes

- v1.412.1: every unused pool account came with the seller's cookie, which
  the switch read as a live session and refused. An account no fleet worker
  has held (no claim by a fleet host, no stint under a worker) now switches.
- Canary run 2026-11-03 on prod (release #1067): 0.16.0 staged at 18:09 UTC,
  account #76 (seller batch Order 2822048) switched to CloakBrowser before
  its first claim. homelab-10 started on 0.16.0 at 18:10:13, claimed it, and
  hit a Facebook locked wall (CHECKPOINT) 17 s later: the seller's cookie
  was invalid and the password login was walled. On stock, 30 of the 37
  accounts claimed from the same batch were retired within hours, so this
  single result does not separate the engine from the batch. No other
  worker was restarted.
