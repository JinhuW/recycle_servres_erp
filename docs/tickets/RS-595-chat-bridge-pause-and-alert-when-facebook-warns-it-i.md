---
id: RS-595
title: Chat bridge: pause and alert when Facebook warns it is limiting an account
type: story
status: done
priority: P2
created: 2026-11-15
reporter: jinhu
branch: session/20261115-200524
pr: 1218
version: 1.465.0
related: []
---

## Ask

> help me deep review the current facebook extension to see if it may detect by the facebook that we are bridgeing the message to the telegram and erp

> help me ultrathink and see if you can help me resolve all these risks

> yes, go ahead with everything,

## Context

A review of the Marketplace ⇄ Telegram bridge extension found that only
login and checkpoint pages stopped it. An in-page warning that Facebook is
limiting the account ("You're temporarily blocked", "going too fast", a
security check) did not, so the bridge kept reading and typing after it,
which is how a warning becomes a restriction. Extension 0.6.0 detects those
warnings, stops for a set number of hours (`blockPauseHours`, 12 by default),
and reports `restricted` with `detail.restriction = 'blocked'`. Before this
change the hub stored any restriction it did not know as `login` and told
General that Facebook was showing a login page.

## Acceptance criteria

- [x] `fb_chat_accounts.restricted` accepts `blocked` (migration 0248).
- [x] A `blocked` event posts one warning in General that names the warning
      and when the pause ends, and holds the account's replies.
- [x] The Chats and Accounts tabs show the account as "Limited by Facebook".
- [x] Older extensions, which send only `login` and `checkpoint`, behave as before.

## Out of scope

The extension's own changes (fewer reloads, notice delay, input shape), which
live in `facebook_messager_extenion`.
