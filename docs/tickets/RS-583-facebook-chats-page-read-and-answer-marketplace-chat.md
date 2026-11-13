---
id: RS-583
title: Facebook chats page: read and answer Marketplace chats in the ERP
type: story
status: in-review
priority: P2
created: 2026-11-12
reporter: jinhu
branch: session/20261112-193240
pr:
version: 1.456.0
related: [RS-578, RS-579, RS-582]
---

## Ask

> we may have overall 10 of buyers account and use the extension to bridge it will the telegram. reuse the structure of page. It should have a setting page, Chat page which is similiar with the facebook messager. the left side nav have a list of communication. So which meant we can both chat in the telegram, but also our erp website.

and later:

> i believe you will need to include a approva connection page. for approve the extension to connect.

and:

> update the account to the same level as chat and settings

## Context

The Facebook chat hub (RS-578) relays each buyer account's Marketplace chats
into one Telegram group, a topic per chat, and types the replies written
there back into Messenger through a Chrome extension per account. Its only
page in the ERP is Settings ▸ Chat bridge: a settings form and the list of
extensions waiting for approval (RS-582). Nobody can read or answer a chat in
the ERP, and with about ten buyer accounts the one settings panel no longer
says which account is healthy.

The owner approved a clickable mockup on 2026-11-12
(`fb-chats-design.html`, kept outside the repo). It is the source for layout,
copy and states. Decisions taken with the owner:

- The page is Leads ▸ Facebook, for managers, with three tabs at the same
  level: Chats, Accounts, Settings. It replaces Settings ▸ Chat bridge.
- A reply can be typed in the ERP as well as in Telegram. An ERP reply goes
  through the same outbox as a Telegram one and is also posted into the
  chat's topic, attributed like "Jin (ERP): text". Every message records
  where it was typed (Facebook, Telegram or the ERP) and, for the ERP, who.
- Unread is shared by the team: one read mark per chat, not one per user.
- Text replies only.
- The page shows only what the server knows. It has no "Off in Chrome"
  state, no last-error column and no "read every chat again".
- The extension contract is frozen: `/api/fb-chat/push/*` and `/enroll` keep
  accepting exactly what extensions 0.2.0 and 0.3.0 send.

## Acceptance criteria

- [ ] Managers see Leads ▸ Facebook in the sidebar with a count of unread
      chats; purchasers do not see it and are sent Home from its address.
- [ ] Chats: a list of chats on the left that can be narrowed to one account,
      searched by name, listing or message text, and filtered to Unread or
      Not sent; the open chat in the middle; the buyer's details on the
      right, with the same buyer's chats on our other accounts.
- [ ] Each outbound message says where it was typed and by whom, and a reply
      shows as queued, typing, sent or not sent.
- [ ] A reply typed in the ERP reaches the buyer through the account's
      extension and appears in the chat's Telegram topic with the sender's
      name and "(ERP)".
- [ ] A reply that failed, or may not have arrived, can be retried from the
      chat.
- [ ] Opening a chat marks it read for everyone; "Mark as unread" puts the
      mark back.
- [ ] Accounts: each waiting extension is a card with its pairing code,
      Chrome profile, Facebook user, browser, IP address and version. Approve
      takes a name and an optional "start with sending paused"; Deny refuses
      it. A request from a Facebook user that is already an account offers
      Reconnect instead, which replaces that account's old Chrome and keeps
      its chats.
- [ ] Accounts: one row per Facebook account with its status (running,
      paused, needs login, checkpoint, not checking in), replies waiting,
      last sync, extension version, whether it has picked up the current
      settings, and the Chrome that relays it. A row can be renamed, paused
      or resumed, and its Chrome disconnected without losing its chats.
- [ ] A name given in the ERP stays when the extension next reports its own
      profile name.
- [ ] Settings: Sending (pause, time between replies, typing pace), Reading
      the inbox (inbox refresh as one range, quiet chat wait) and Advanced
      (settings check, closed by default), each editable for every account
      or for one, with a reset back to every account's value. A field an
      extension reports that is in none of those groups is shown and
      editable under Advanced.
- [ ] Settings shows whether Telegram is connected and how many topics exist.
- [ ] Settings ▸ Chat bridge is gone; nothing it did is lost.
- [ ] Every string on the page is in English and Chinese.
- [ ] Extensions 0.2.0 and 0.3.0 keep working unchanged.

## Out of scope

- Sending photos from the ERP.
- Starting a purchase order from a chat.
- Archiving a chat.
- A per-user read state.
- Showing whether the bridge is switched off in a Chrome, the extension's
  log, or "read every conversation again": those stay in the extension.
- A phone layout. The page is desktop only.

## Notes

Contract, migration (0241) and file ownership:
`docs/superpowers/specs/2026-11-12-facebook-chats-page.md`.
