---
id: RS-428
title: Reddit Seen tab: who saw each alert in the last 24 hours
type: story
status: in-progress
priority: P2
created: 2026-10-27
reporter: jinhu
branch: JinhuW/reddit-seen
pr:
version:
related: []
---

## Ask

> Any chance you can detect telegram active users in a channel?

> Yes. I meant i want to check message seen count.

> [screenshot of Monitors ▸ Reddit ▸ Analytics]
> I would like to add a new tab for the reddits.
> It will tracking all seen user for all alerts in the past 24 hours.

Asked how to get "seen by" given Telegram only reports readers of a user
account's own messages, the owner chose "Send alerts as a user (Recommended)",
then added:

> Let we keep the bot and user sent alert first.

## Context

Buyer alerts go to one supergroup, *Recycle Servers - Reddit Alerts*
(`-1003943525487`, 9 members on 2026-10-27), sent by the tracker's bot
(`trackers/reddit/src/telegram.ts`). Telegram exposes who read a group
message only through `messages.getMessageReadParticipants`. That method is
MTProto-only, so bots can't call it. It answers only for the sender's own
messages, in groups of up to 100 members, for 7 days. So the alerts have to
be sent by a user account for anyone to know who saw them.

## Acceptance criteria

- [x] Monitors ▸ Reddit has a **Seen** tab (`/tracker/seen`) listing the buyer
      alerts of the last 24 hours with who read each.
- [x] The tab lists everyone in the alert group with how many of those alerts
      they saw and when they last read one, including people who saw none.
- [x] With a user session on the tracker api, buyer alerts go out as that user
      account, and the bot sends to any chat the user account fails.
- [x] Workers stop sending buyer alerts while the api's user session is live,
      and resume through the bot when it goes stale.
- [x] Without a session, alerts go out from the bot as before, and the tab
      says those alerts carry no receipts.
- [x] `GET /api/tracker/seen` is manager-only.

## Out of scope

- Tracking link opens with a tap-to-open button: offered and not chosen.
- Dev-chat reviews and reactions stay on the bot.
- Windows other than 24 hours.

## Notes

- The user session lives in the api only. One session used from several IPs
  gets revoked (`AUTH_KEY_DUPLICATED`), and notify used to run on every
  worker. The handover goes through `telegram_state.user_sender_at`, and the
  post claim still keeps it to one alert per post.
- Going live needs the owner to log the sending account in once
  (`trackers/reddit/scripts/telegram-login.ts`, a phone code), add it to the
  alert group, and set the three env vars on the Railway `api` service.
