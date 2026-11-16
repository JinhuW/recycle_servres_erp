---
id: RS-593
title: Send website lead alerts to a dedicated Telegram group
type: story
status: in-progress
priority: P2
created: 2026-11-15
reporter: jinhu
branch: session/20261115-184220-lead-group
pr:
version:
related: [RS-591]
---

## Ask

> i would like to send the alerts to a dedicated group.

> pls reuse my service account

> i just created a new group for the 339* telegram account

## Context

Since v1.462.0 (RS-591) website lead alerts went to the General topic of the
Facebook chat hub's Telegram group, mixed with the chat bridge. The hub posts
as the owner's service account (`FB_CHAT_TELEGRAM_SESSION`), whose session may
be connected from one place only, so a second sender is not an option: the
hub's own connection has to post to the new group.

## Acceptance criteria

- [x] With `WEB_LEAD_TELEGRAM_CHAT_ID` set, the hub posts each `web_lead`
      alert to that chat, as the same bot or service account; account alerts
      stay in the hub group.
- [x] Unset, lead alerts still go to the hub group's General topic.
- [x] A lead chat the sender can't post to keeps the alert queued, retries a
      minute later, and holds up no other alert.
- [x] In account mode a post to the lead chat is not mistaken for a reply in
      the hub group.

## Out of scope

- A separate bot for leads: the owner asked to reuse the service account.
- Setting the chat on a Settings page; it is a backend variable.

## Notes

- The account resolves the lead chat from its dialog list, re-reading it once
  if the group was joined after the session connected.
