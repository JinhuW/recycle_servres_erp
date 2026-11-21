---
id: RS-601
title: Reddit subreddit backoff overflows after ~37 errors and the failure repeats forever
type: bug
status: in-progress
priority: P2
created: 2026-11-21
reporter: jinhu
branch: fix/reddit-dedup-memory-generation
pr:
version:
related: []
---

## Ask

> yes.

(Reply to: "Want me to do either? Code: cap the exponent … Config: disable the five 404 subreddits …", found while verifying the RS-600 deploy.)

## Context

`releaseSubredditFailure` (`trackers/reddit/src/claims.ts`) computed
`poll_interval_seconds * POWER(2, consecutive_errors + 1)` before the
`LEAST(…, 30 minutes)` cap. At 90 s and ~37 errors the product exceeds
Postgres' interval range, so the UPDATE threw `interval out of range`. The
error count it should raise never moved, the claim only lapsed by TTL, and
every retry logged `poll iteration failed` at ERROR to the ops group.

On 2026-11-20 five subreddits had answered HTTP 404 since about 2026-11-18
and sat at 34–36 errors: bostonforsale, ewastescrap, minerswap, msp,
pcmasterrace.

## Acceptance criteria

- [x] A subreddit at any error count backs off to the 30-minute cap without
      an error (`tests/claims.test.ts`, "failed for days").
- [x] The five 404 subreddits are disabled in production
      (`PATCH /api/subreddits/:name {"enabled":false}`, 2026-11-20).

## Out of scope

- Auto-disabling a subreddit after N 404s. Re-enable by hand once one is
  public again.
- `releasePostFailure` uses the same pattern but is bounded by MAX_ATTEMPTS.
