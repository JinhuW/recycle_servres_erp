---
id: RS-455
title: Fleet workers take settings and alert config from the ERP while running
type: story
status: backlog
priority: P1
created: 2026-10-29
reporter: jinhu
branch: JinhuW/rainbowfish
pr:
version:
related: [RS-453, RS-394]
---

## Ask

> let we update the alerts threadhold, also 4 rate can also sent alerts to the low priority topics.

> for some reason, you are not sending alert to channels.

> figure out some approach to fetch all these configuration without restart the servers.

> could we pull some configuration from api instead of a configuration file?

> yes. go ahead.
>
> also send the lgeacy alerts in the past 24 hours to the telegram with RS alerts account.

## Context

A fleet worker reads everything once, at boot. The entrypoint
(`trackers/facebook/rs_worker/entry.py`, `render_config`) writes the claim's
search settings and the shared env (`FLEET_WORKER_ENV`, added to the claim by
the Cloudflare Worker, `deploy/cloudflare/worker.js`) into
`~/.ai-marketplace-monitor/config.toml`. The monitor's fleet loop
(`_fleet_marketplace` in the vendored monitor's `monitor.py`) loads that file
once and runs every task on that copy. So:

- The settings the ERP edits (Fleet ▸ Analysis, `fleet_settings.search`:
  rating gate, minimum units, prompts) reach no running worker.
- Alerts were left off at the ERP-fleet cutover (`RS_ALERTS` absent from
  `FLEET_WORKER_ENV`). Turning them on (2026-10-29) reaches a worker only at
  its next start, and every start is a Facebook login.
- Topic routing is fixed in the monitor (`alert_priority`: by unit count
  only), so "rating 4 to Low" needs a new image.

The worker already asks the ERP for work every few seconds
(`POST /api/fleet/worker/next-task`), and that handler loads the settings on
every call (`apps/backend/src/fleet/claim.ts`). That is the channel.

Stopgap, live since 2026-10-29: `trackers/facebook/scripts/fleet-alert-sender.py`
(cron on the homelab VM) sends what running workers withheld, through the
coordinator's claim dedupe, rating 4 to Low; it sent the 24 h backlog (23
alerts, 19 already alerted on 10-23/10-27, 3 price drops).

## Acceptance criteria

- [ ] `next-task` answers carry `settings: {version, search, alerts}` when the
      version differs from the `settings_version` the worker sent.
- [ ] A worker applies a new version between tasks, without a new browser or
      a restart: the rating gate, minimum units, prompts, the title prefilter,
      and alerts on/off.
- [ ] `fleet_settings.alerts` holds the switch and the rating-to-topic rules
      (default: rating 4 to Low, rating 5 by unit count); the alert stage on
      Fleet ▸ Analysis edits them.
- [ ] Secrets (Telegram bot token, OpenRouter key) come from a worker-token
      route the Cloudflare Worker fills from `FLEET_WORKER_ENV`, as the claim
      is filled today; they never enter Postgres or Railway.
- [ ] A worker image without the change keeps working against the new ERP
      (it ignores `settings`), and a new image against an ERP without it
      runs on its boot config as today.
- [ ] Once every worker runs the new image, the bridge and sender cron lines
      are removed (`~/fleet-ai-bridge/` on both hosts).

## Out of scope

- Restarting running workers to adopt the image: they take it at their next
  natural start.
- Proxy, account and browser profile: these are what a container is, and stay
  boot-only.
- Items and search phrases per city: tasks already carry them.

## Notes

Plan: [docs/superpowers/plans/2026-10-29-fleet-live-settings.md](../superpowers/plans/2026-10-29-fleet-live-settings.md).
