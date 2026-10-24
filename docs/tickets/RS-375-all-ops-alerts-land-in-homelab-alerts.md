---
id: RS-375
title: All ops alerts land in Homelab Alerts
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/telescopefish-alerts
pr: 849
version: 1.325.0
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

- [x] The relay's `POST /alert` takes `{topic, status, title, lines, link}`
      with its own bearer (`ALERT_TOKEN`). It answers 401 without that bearer
      and maps the topic key to a thread; an unknown key goes to General
- [x] A failing uptime run posts to "ERP · Uptime", says which layer broke,
      and still exits 1
- [x] Facebook coordinator ops alerts go to "Facebook · Fleet ops", and
      deploy notices to "Facebook · Releases", once `TELEGRAM_OPS_CHAT_ID` is
      set. With it unset, nothing changes
- [x] Alertmanager's alerts land in "Homelab · Prometheus", firing and
      resolved

## Out of scope

- Lead alerts: the reddit leads group and the Facebook High/Medium/Low
  topics. Buyers read those.
- The eBay tracker, which has been offline since 2026-09-18.

## Notes

- Topics in Homelab Alerts (`-1004378564833`): Homelab · Prometheus 12,
  Facebook · Fleet ops 13, Facebook · Releases 14, ERP · Uptime 15,
  Reddit · Workers 16, Reddit · Errors 17.
- v1.325.0 (PR 849) ships the relay route and the uptime cron. The uptime
  service builds from `dev` on changes under `deploy/railway-uptime/`, so it
  goes live with the merge.
- The Facebook part is facebook-tracker 0.13.15 (PR 854): the coordinator's
  ops alerts, deploy notices and fleet-verify reports follow
  `TELEGRAM_OPS_CHAT_ID` and its topics. It goes live when the VM's
  `configs/secrets.env` sets `TELEGRAM_OPS_CHAT_ID=-1004378564833`,
  `TELEGRAM_TOPIC_OPS=13` and `TELEGRAM_TOPIC_RELEASES=14` and 0.13.15 is
  deployed. That needs `@recycle_facebook_alerts_bot` in the group, and the
  city-queue pilot session agreeing to a restart.
- Alertmanager is a config change on `10.10.60.5`, outside the repo: in the
  `telegram` receiver, `chat_id: -1004378564833` and `message_thread_id: 12`.
- memtrade's daily WeChat report posts its failures to "WeChat · Daily
  report" (thread 28) through the relay. That session added the topic, and
  v1.325.0 maps `wechat_report` to it.
- **Closed 2026-10-23.**
  - **Facebook:** 0.13.15's code went live with the pilot session's 0.13.16
    deploy (workers held). After `@recycle_facebook_alerts_bot` joined the
    group, the VM's `secrets.env` got `TELEGRAM_OPS_CHAT_ID`,
    `TELEGRAM_TOPIC_OPS=13`, and `TELEGRAM_TOPIC_RELEASES` 36 → 14. Only
    `rs-coordinator` was recreated. One test through the coordinator's ops
    notifier and one deploy-style notice landed in topics 13 and 14.
  - **Alertmanager:** went from 0.27.0 to 0.28.1 (0.27 rejects
    `message_thread_id`) with `chat_id` set to the group and topic 12. A test
    alert sent one notification with no failures. Backups are
    `*.bak-20261023-rs375` on the host. The `homelab-monitoring` clone it is
    synced from still needs the same edit.
