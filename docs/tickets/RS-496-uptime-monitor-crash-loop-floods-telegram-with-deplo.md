---
id: RS-496
title: Uptime monitor crash loop floods Telegram with deploy alerts
type: bug
status: done
priority: P2
created: 2026-11-01
reporter: jinhu
branch: fix/uptime-monitor-crash-loop
pr:
version: 1.401.1
related: []
---

## Ask

> In the telegram. there is lots of alerm about the deployment crash. pls review them and fix them,.

## Context

On 2026-10-28 21:11 UTC the `uptime-monitor` cron got HTTP 429 from Cloudflare
on both `inventory.recycleservers.com` and the alert relay for one run. Prod was
healthy (origin 200, edge back to 200 on the next request). `check.sh` exited 1,
so Railway marked the deployment CRASHED and kept re-running the service, each
time as a redeploy of commit `c881951`, whose snapshot it could no longer fetch
("failed to fetch snapshot"). That left a "Deploy failed" alert roughly every
four hours from 10-28 to 11-02, and no uptime probes for those four days. No
other Railway project had crashed or failed deployments in that window.

## Acceptance criteria

- [x] `uptime-monitor` runs again from the `dev` head and probes every 5 minutes.
- [x] A failing probe whose alert reaches the relay exits 0, so it no longer
      marks the deployment CRASHED.
- [x] The relay post is retried once, since it shares the Cloudflare edge that
      may be failing.
- [x] A run whose alert can't be sent still exits 1, so Railway's own webhook
      remains the fallback.

## Out of scope

Why Cloudflare answered 429 for that one minute. It hit both hostnames on the
account together and cleared on its own.

## Notes

Ops fix: `railway redeploy --from-source -s uptime-monitor -e production`
(a plain redeploy rebuilds the unfetchable snapshot).
