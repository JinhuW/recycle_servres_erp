---
id: RS-580
title: Chat hub wakes a held reply claim on NOTIFY instead of polling every second
type: task
status: done
priority: P2
created: 2026-11-11
reporter: jinhu
branch: perf/fb-chat-claim-wakeup
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1186
version: 1.453.1
related: [RS-578, RS-579]
---

## Ask

> just for curious how current chrome extension with the telegram bridge get built?
> socket or http?
>
> which is better in this case?

> evaluate the improvement and start the implementation.

## Context

The Marketplace extension long-polls `POST /api/fb-chat/push/outbox/claim`
(`wait: 25`) for replies typed in Telegram. While held, the route re-ran
`claimReply` (a transaction with two UPDATEs) every second, about 25 queries
per hold per extension, and a reply queued in that second waited up to 1 s.
A redeploy's drain also had to wait out every held claim, or cut it.

The fleet's next-task long poll already solved this with LISTEN/NOTIFY
(`fleet/claim.ts`). The claim now uses the same mechanism, moved to
`lib/pgWake.ts` so both share it.

Of the two improvements weighed, the other one was making the bot-mode
`getUpdates` a long poll (`timeout` > 0) instead of a 2 s short poll. It is
left out: the same tick also mirrors, renames and acks, so a 25 s hold
needs its own loop and lock; user-account mode has no `getUpdates`; and it
saves only about 1 s of average latency on a path where the extension then
waits seconds on purpose before typing.

## Acceptance criteria

- [x] A held claim answers within a second of a Telegram reply being queued
      on any backend instance.
- [x] A held claim answers within a second of the send ahead of it being
      reported (the account's next reply becomes claimable).
- [x] A held claim answers 204 at once when the server starts draining, and
      a new one does not hold.
- [x] The fleet next-task hold behaves as before (its tests pass unchanged).
- [x] The extension's HTTP contract is unchanged.

## Out of scope

- Telegram `getUpdates` long polling (see Context).
- Any change to the extension.

## Notes

- NOTIFY goes through the writer's own handle (`SELECT pg_notify`), so one
  sent inside a transaction is delivered at commit.
- The hold still re-checks every 5 s, for writes that free a reply without
  notifying (a stale `sending` claim turning `uncertain` is decided inside
  `claimReply` itself).
