---
id: RS-368
title: Railway alerts reach Telegram, one topic per alert kind
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/telescopefish
pr: 846
version: 1.322.0
related: []
---

## Ask

> [Image #1]
>
> Set up a webhook to my telegram to send alerts about railway.

> Pls enable different topic for different alerts

Image #1 was Railway's project Settings → Webhooks → "New Webhook" form.

## Context

Railway webhooks are set per project, and Railway reformats the payload only
for Discord and Slack. Any other URL gets the raw JSON (`type`, `details`,
`resource`, `severity`, `timestamp`), which Telegram's `sendMessage` can't
read. So something has to translate it. None of the seven Railway projects had
a webhook.

Choices made when this was asked:

- **Bot.** `@Jinhu_homelab_bot`, the bot the homelab's Alertmanager already
  sends as.
- **Chat.** Alerts go to a new forum group, "Homelab Alerts"
  (`-1004378564833`). The bot is an admin there with Manage Topics.
- **Projects.** All seven Railway projects in the workspace.
- **Events.** Deployment failed, crashed and OOM-killed; CPU/RAM monitor
  triggered and resolved; volume alert triggered and resolved. PR environments
  are excluded.

The relay is a Cloudflare Worker (`deploy/railway-alerts/`). It runs off
Railway, so an alert still gets out when Railway is the thing failing. It also
keeps the bot token out of Railway's environment store, which leaked on
2026-10-21.

## Acceptance criteria

- [x] Each of the seven projects has one webhook pointing at the relay. It
      carries an Authorization header, fires on the seven event types, and
      skips PR environments
- [x] The relay answers a request without the right bearer with 401 and sends
      nothing
- [x] Deployment.failed goes to the "Deploy failed" topic. Crashed and OOM go
      to "Crashed", Monitor.* to "CPU/RAM", and VolumeAlert.* to "Volumes"
- [x] A message names the project, environment and service, plus the event.
      It shows the commit when there is one and links to the deployment in
      Railway
- [x] Payload text is HTML-escaped, so a `<` in a commit message can't break
      the send
- [x] If a topic has been deleted, the alert goes to General instead of being
      dropped
- [x] If Telegram rejects the send, the relay returns 502 so Railway retries
- [x] A Railway test event of each kind lands in the right topic

## Out of scope

- Moving the homelab's own Alertmanager alerts from the bot's DM into this
  group.
- Sending uptime-monitor's Lark alert to Telegram as well.
- One topic per project. Every message names its project instead.
- Successful-deploy messages. Every push to dev or main would post one.

## Notes

- The plan first reused the reddit tracker's `@recycle_servers_alert_bot` and
  its leads group. The requester then made a dedicated group with the homelab
  bot, which keeps Railway noise out of the buyers' chat. It also keeps the
  token out of Railway's env, which leaked on 2026-10-21 and is still being
  rotated.
- Topics are General plus `Railway · Deploy failed` (2), `Railway · Crashed`
  (3), `Railway · CPU/RAM` (4) and `Railway · Volumes` (5), created with
  `createForumTopic`.
- Railway's webhook headers had to be set from a logged-in dashboard tab. The
  CLI's OAuth token is Not Authorized for `notificationRuleUpdate`, and the
  MCP tools take no headers. `headers` is a `{name: value}` map; a list of
  `{name, value}` is refused (`docs/agents/erp-ops.md`).
- Railway's test events have an empty `details` and no service, so the
  monitor and volume formatting is generic until a real alert shows the shape.
