---
id: RS-578
title: Facebook chat hub: Chrome extensions relay Marketplace chats to Telegram topics
type: story
status: done
priority: P2
created: 2026-11-11
reporter: jinhu
branch: feat/fb-chat-telegram-hub
pr: 1181
version: 1.451.0
related: [RS-565, RS-571]
---

## Ask

> I would like to create an chrome extension to route the facebook market place message to the telegram and reply the message from the telegram back to the facebook marketplace.
>
> Make sure the facebook marketplace messgae will not detect any bot operations.(mock the keyboard events)
>
> Keep all historical chat history.
> Once someone pinged me. It will create a dedicated top for that chat by using the client name.
> The chrome extension can send real time message to the telegram.

Clarified the same day:

> It may attach to multiple different chrome tab with different login session (User).
>
> But all message will centralized to one telegram channel.
>
> Also pls catpture necessary data for future analysis

> It will be great to cpature buyers profile rate, like his feedback rate.

Answers to questions asked while planning: the logins are separate Chrome
profiles; the hub lives inside the ERP; topics are named "Client Name +
Location"; replies are typed as real keystrokes; a new bot and a new group;
capture the message timeline, the buyer profile and delivery/errors; store in
own tables now and merge into Leads ▸ Facebook later.

## Context

The owner answers Marketplace buyers from several Facebook accounts, each in
its own Chrome profile, and wants to do it from Telegram on a phone.

Each Chrome profile runs its own copy of the extension, and Telegram lets only
one program read a bot's updates. So the bot cannot live in the extension: the
ERP owns it, and every extension copy talks to the ERP.

- The extension (`facebook_messager_extenion/`, its own repo in the workspace)
  reads the inbox and types replies. It never calls Telegram.
- The ERP stores every message, mirrors each conversation into a forum topic
  and queues replies typed in a topic for the extension that owns the thread.

The fleet's seller accounts already have `fb_threads` / `fb_messages`
(RS-565), which an agent may answer and which RS-571 is still reshaping. These
chats are the owner's own accounts and must never be answered by the agent, so
they get their own `fb_chat_*` tables.

## Acceptance criteria

- [ ] An extension with a `fbchat:write` service client can push a thread; one without the scope gets 403.
- [ ] The first push of a thread creates one Telegram topic named `<buyer> · <location>` (or `<buyer>` when no location is known) and posts the conversation so far.
- [ ] A later push posts only the messages the ERP has not seen, each once, whichever account or profile sent it.
- [ ] A text reply in a topic is handed to the extension of the account that owns the thread, and to no other.
- [ ] A reply is acknowledged in Telegram once the extension reports it sent, and an error is posted when it failed.
- [ ] A reply typed on Facebook directly appears in the topic; a reply sent from Telegram does not appear twice.
- [ ] The buyer's name, location, join year, star rating and rating count are stored, and a change in rating is recorded as an event.
- [ ] A login or checkpoint page on an account raises one alert in the group's General topic and stops that account's sends.
- [ ] With no bot token configured the push routes still store everything and nothing calls Telegram.

## Out of scope

- A page in the ERP for these chats. They are read from Telegram, and analysed from the tables.
- Folding these chats into Leads ▸ Facebook. To be done after RS-571 ships.
- Sending photos or files from Telegram to Facebook. Text only.

## Notes

- Telegram is read with a short `getUpdates` poll under an advisory lock, not a
  webhook, so a dev instance without a public URL works the same way and two
  backend instances never both consume updates.
- The bot needs its own token. The Facebook coordinator polls another bot, and
  two pollers on one token take each other's updates.
- 2026-11-11, after the first look at the live inbox: conversations there are
  buttons that open a chat window on the same page, with no id and no URL. The
  extension keys a conversation by its title, and v1.451.1 dropped the dead
  thread link from the topic header and added `fb_sent_label`.
- 2026-11-11: the owner asked to use a Telegram account ("service account")
  instead of a bot. v1.452.0 adds that mode alongside the bot; the app was
  created on my.telegram.org from the owner's browser at their request, and
  the session string is made by the owner with `scripts/telegram-session.ts`.
