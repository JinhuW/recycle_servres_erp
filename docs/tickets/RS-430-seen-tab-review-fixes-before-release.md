---
id: RS-430
title: Seen tab review fixes before release
type: bug
status: in-review
priority: P1
created: 2026-10-27
reporter: jinhu
branch: JinhuW/seen-review-fixes
pr:
version:
related: [RS-428]
---

## Ask

> /code-review high from dev to main.
> fix all issue and release to prod.

## Context

The dev → main review of RS-428 (Reddit Seen tab) turned up ten problems.
The one that mattered most: a Railway redeploy of the reddit `api` runs the
old and new copies side by side for a few seconds, and both opened the
Telegram user session. Telegram revokes a session it sees live from two
places (AUTH_KEY_DUPLICATED), and getting it back needs a phone login.

## Acceptance criteria

- [x] A new api connects the user session only after the old one has
  disconnected and let go (`telegram_state.user_sender_owner`), or after its
  hold is two minutes stale. Renew and release touch only the holder's row.
- [x] A client that fails after `connect()` is destroyed, not left reconnecting.
- [x] A chat id missing from GramJS's cache reloads the dialogs (at most every
  10 minutes) instead of failing every alert; boot loads all dialogs.
- [x] The Seen tab counts each person against alerts sent to their own chats,
  and each alert against the members of its own chat.
- [x] A member list Telegram returns only part of marks nobody as left.
- [x] The reads loop asks only about the last 24 hours, and skips alerts every
  rostered member already read.
- [x] Basic groups get alerts from the bot, so reactions keep matching.
- [x] The Seen liveness check reuses `userSenderLive` from the notify loop.
- [x] The tracker api is deployed with `/api/seen` before the ERP reaches main.

## Out of scope

—
