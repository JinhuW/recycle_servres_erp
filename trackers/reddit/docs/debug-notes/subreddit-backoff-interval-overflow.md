# `poll iteration failed: interval out of range` on every poll

**Date:** 2026-11-20 · **Symptom:** a worker logs
`ERROR (poll) poll iteration failed {"error":"interval out of range"}`, and
`GET /api/subreddits` shows some subreddits stuck at a high
`consecutive_errors` (34–36) that never rises, with an old `last_polled_at`.

## Cause

The failure backoff in `releaseSubredditFailure` multiplied
`poll_interval_seconds * 2^(errors + 1)` and only then capped it with
`LEAST(…, INTERVAL '30 minutes')`. Postgres evaluates the `make_interval`
first, and past about 37 errors (at 90 s) the value is outside the interval
range, so the UPDATE that records the failure throws. Nothing raises the
count or releases the claim; the claim lapses by TTL and the same failure
repeats, each time at ERROR, so it pages.

It took a subreddit going 404 (banned or private) for days to reach that count.

## Fix

The exponent is capped (`LEAST(consecutive_errors + 1, 10)`) before the
multiply. A subreddit that answers 404 for good should still be disabled:
`PATCH /api/subreddits/:name {"enabled": false}`.

## Rule

When capping a computed value in SQL, cap the input, not only the result.
`LEAST(overflowing_expr, cap)` still evaluates the overflow.
