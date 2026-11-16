---
id: RS-594
title: Stop paging on transient Telegram getUpdates failures in the Reddit tracker
type: bug
status: in-progress
priority: P3
created: 2026-11-15
reporter: jinhu
branch: session/20261115-201543
pr:
version:
related: []
---

## Ask

> fix these errors:
> [Image #1]
>
> i received them in my reddits alerts

(The screenshot shows the Homelab Alerts group: "Reddit: 1 warn/error line —
1× reactions · getUpdates failed: fetch failed — dd077ec14c4c-1-gygw" many
times a day, and "4× reactions · getUpdates rejected" at 8:13 PM.)

## Context

The api's reactions loop long-polls Telegram's `getUpdates` and logged every
failure at warn, so each one reached the ops group. The api's Railway logs for
2026-11-13 to 11-16 show two kinds, both harmless:

- `fetch failed` a few times an hour, single drops; the next poll succeeds.
- Every night at about 01:12 UTC, two minutes of 502 Bad Gateway, an
  occasional 429 and two long-poll timeouts: Telegram's own Bot API restart.

Neither loses a reaction. Telegram keeps updates for 24 hours and the cursor
only advances after a successful poll.

## Acceptance criteria

- [x] A network error, timeout, 5xx or 429 from `getUpdates` logs at info
      while the run of failures is shorter than 10 minutes.
- [x] Past 10 minutes of continuous failure it logs at warn, so a real outage
      still reaches the digest and pages after three iterations.
- [x] A successful poll ends the run; after a long outage it logs
      "getUpdates recovered".
- [x] A 4xx other than 429 (bad token, 409 conflict) still warns at once.
- [x] Network errors log undici's `cause` code, since "fetch failed" alone
      says nothing.

## Out of scope

Retrying a dropped poll at once, or honouring `retry_after`: the loop's 5 s
idle pause already spaces retries, and no data is at stake.
