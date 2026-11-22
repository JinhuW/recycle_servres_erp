---
id: RS-591
title: Send a Telegram lead alert for each website submission
type: story
status: done
priority: P2
created: 2026-11-15
reporter: jinhu
branch: session/20261115-184220
pr: "#1210"
version: 1.462.0
related: []
---

## Ask

> for the Website submission, Pls also send and lead alerts to the telegram to inform us.

## Context

A ram4cash.com sell lot (`POST /api/public/intake`) or a recycleservers.com
quote (`POST /api/public/quote`) stored a `WS-nnnn` row and an in-app notice
for managers (`routes/publicForms.ts`), and nothing else, so a lead waited
until someone opened the ERP. The team already watches the Facebook chat hub's
Telegram group, and the hub already posts account alerts to its General topic
from `fb_chat_events.alert` (`services/fbChatTelegram.ts`, `postAlerts`).

## Acceptance criteria

- [x] Each stored sell lot or quote queues one Telegram alert in the same
      transaction as the submission; a refused or honeypot request queues none.
- [x] The chat hub posts it once to its group's General topic: the form, the
      `WS` reference, the contact, the lines or hardware, and the notes.
- [x] The hub is woken when the submission commits, so the alert goes out
      within seconds instead of on the next tick.
- [x] With the hub unconfigured the alert waits; the form still answers 201.

## Out of scope

- A separate bot token or chat for leads. Production has no Telegram settings
  at all, and the hub's group is where the team already reads alerts; one
  setup covers both.
- Alerts for the email replies on a submission's thread.

## Notes

- The alert is an `fb_chat_events` row with `kind = 'web_lead'`, no account
  and no thread, `detail.submission_id` naming the submission
  (`lib/webLeadAlert.ts`). Riding the hub's queue means a Telegram outage only
  delays the alert, and it works whether the hub posts as a bot or as its
  account.
- Production has none of the `FB_CHAT_TELEGRAM_*` variables, so alerts reach
  Telegram there only once the hub is configured; dev has them.
