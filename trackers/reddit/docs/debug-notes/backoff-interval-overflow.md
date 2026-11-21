# Subreddit backoff overflowed and stalled the whole fleet

**Seen:** 2026-11-17 ~18:00 → 2026-11-18 ~14:30 UTC. No post was evaluated and
no alert went out for about 20 hours.

## Symptom

- Worker: `ERROR (poll) poll iteration failed {"error":"interval out of range"}`
  exactly every 300 s (`CLAIM_TTL_SECONDS`).
- Postgres: matching `ERROR: interval out of range`.
- Before it: a run of `WARN (poll) reddit fetch failed {"error":"HTTP 404"}`.

## Cause

`releaseSubredditFailure` (`src/claims.ts`) set

```sql
next_poll_at = NOW() + LEAST(
  make_interval(secs => poll_interval_seconds * POWER(2, consecutive_errors + 1)),
  INTERVAL '30 minutes')
```

`LEAST` only caps the interval Postgres has already built, and
`consecutive_errors` had no ceiling. Past about 36 errors (at 90 s) the
interval is out of range, so the UPDATE throws.

- The claim is then never released and the counter never moves. The row keeps
  the oldest `next_poll_at`, so it is reclaimed first when its claim expires,
  and fails again.
- The UPDATE covers the whole claimed batch, so the healthy subreddits in it
  stall too.

The counter climbed because a batch is fetched as one `r/a+b+c` request. One
banned, private or deleted subreddit makes the whole request 404, and every
subreddit in the batch is marked failed.

## Fix

The exponent is clamped (`LEAST(consecutive_errors + 1, 16)`, and the same in
`releasePostFailure`). `tests/claims.test.ts` covers a subreddit at 500 errors.

The 404 still counts against the whole batch. Splitting a failing batch would
break the one-request-per-cycle invariant (AGENTS.md), so that change is a
separate decision. In the meantime, find the dead subreddit with:

```sql
SELECT name, consecutive_errors, last_status, enabled
  FROM subreddits ORDER BY consecutive_errors DESC;
```

Disable the dead one with `PATCH /api/subreddits/:name`.
