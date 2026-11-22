# Reddit is retiring RSS (announced for 2026-11-13): feeds answer 404

**Discovered:** 2026-11-20, while reviewing Reddit's API terms for outreach.

## Symptom

A feed request answers **HTTP 404** with a 266-byte, empty Atom document:

```
GET https://www.reddit.com/r/homelabsales/new.rss   → 404 application/atom+xml
GET https://www.reddit.com/r/homelabsales/new/.rss  → 404
```

From the office IP, on 2026-11-20 and again on 2026-11-22, this held for every
subreddit tried, including ones that certainly exist (r/hardwareswap,
r/homelab, r/news). The rate-limit headers still come back, so the request
reaches Reddit; Reddit has stopped serving the feed to that client.

**The fleet may not be there yet.** While fixing RS-601 on 2026-11-20/21,
another session saw only five subreddits answer 404 from the fleet
(see `subreddit-backoff-interval-overflow.md`), and read those as banned or
private. The shutdown is probably rolling out by IP or by subreddit. Before
treating a new 404 as a dead subreddit, fetch r/news from the same host: if
that 404s too, it's the retirement, not the subreddit.

`fetchFeed` maps a 404 to `gone`, and `fetchNewPosts` reports that as
`{kind: 'error', message: 'HTTP 404'}`. Once every batch 404s, the poll loop
logs an error on every cycle and no post reaches the evaluator. No alert
reaches Telegram, and no new seller reaches the ERP's Leads ▸ Reddit pool.

## Why

Reddit's admins announced on 2026-09-30 (r/redditdev and r/modnews) that RSS
would stop on 2026-11-13. Public Data API access ends in March 2027.

## Every anonymous path is closed (probed 2026-11-20)

| Path | Result |
| --- | --- |
| `/r/<sub>/new.rss`, `/r/<sub>/new/.rss` | 404 |
| `/r/<sub>/new.json` | 403 HTML block page |
| `old.reddit.com/r/<sub>/new/` (and `.rss`) | 302 to login |
| `www.reddit.com/r/<sub>/new/` HTML | 200, but an 8 KB `js_challenge` shell with no posts |
| `/svc/shreddit/community-more-posts/…` | 403 |

## What to do

There is no fix inside `reddit.ts`: a new data source is an owner decision
(cost, and the account risk of a logged-in browser). The options are in the
root `docs/superpowers/plans/2026-11-20-reddit-outreach.md`, Workstream B.
Don't retry RSS URL variants or User-Agents; they were all tried.
