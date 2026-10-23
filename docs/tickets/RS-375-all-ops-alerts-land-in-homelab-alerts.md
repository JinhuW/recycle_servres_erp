---
id: RS-375
title: All ops alerts land in Homelab Alerts
type: story
status: in-progress
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/telescopefish-alerts
pr:
version:
related: [RS-368, RS-376]
---

## Ask

> migrate all my alerts to this location.

"This location" is the "Homelab Alerts" Telegram forum group that RS-368 set
up for Railway alerts.

## Context

The ops alerts were scattered across three places:

- **Homelab Prometheus.** Alertmanager 0.27 on `10.10.60.5` DMs the
  requester as `@Jinhu_homelab_bot`.
- **Facebook coordinator.** Its ops alerts (worker down, session expiring,
  challenge raised) landed in the buyers' listings group, in General, because
  `TELEGRAM_OPS_CHAT_ID` was never set. Release notices went to topic 36 of
  that same group.
- **ERP uptime monitor.** A prod outage reached no one: the Lark
  `ALERT_WEBHOOK_URL` was unset.

The requester picked these three to migrate. Lead alerts stay where the
buyers read them.

The relay (`deploy/railway-alerts/`) gains `POST /alert` for senders that only
speak HTTP. They name a topic key, and only the relay knows the group and the
thread ids. Alertmanager and the coordinator already talk to Telegram, so they
keep their own bots and get the group's chat id plus a topic.

## Acceptance criteria

- [ ] The relay's `POST /alert` takes `{topic, status, title, lines, link}`
      with its own bearer (`ALERT_TOKEN`). It answers 401 without that bearer
      and maps the topic key to a thread; an unknown key goes to General
- [ ] A failing uptime run posts to "ERP · Uptime", says which layer broke,
      and still exits 1
- [ ] Facebook coordinator ops alerts go to "Facebook · Fleet ops", and
      deploy notices to "Facebook · Releases", once `TELEGRAM_OPS_CHAT_ID` is
      set. With it unset, nothing changes
- [ ] Alertmanager's alerts land in "Homelab · Prometheus", firing and
      resolved

## Out of scope

- Lead alerts: the reddit leads group and the Facebook High/Medium/Low
  topics. Buyers read those.
- The eBay tracker, which has been offline since 2026-09-18.
