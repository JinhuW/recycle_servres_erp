# Reddit retired RSS on 2026-11-13: every poll is a 404

**Discovered:** 2026-11-20, while reviewing Reddit's API terms for outreach.

## Symptom

Every feed request answers **HTTP 404** with a 266-byte, empty Atom document:

```
GET https://www.reddit.com/r/homelabsales/new.rss   → 404 application/atom+xml
GET https://www.reddit.com/r/homelabsales/new/.rss  → 404
```

`fetchFeed` maps a 404 to `gone`, and `fetchNewPosts` reports that as
`{kind: 'error', message: 'HTTP 404'}`. So the poll loop logs an error on
every cycle and no post reaches the evaluator. No alert reaches Telegram, and
no new seller reaches the ERP's Leads ▸ Reddit pool. The rate-limit headers
still come back, so the request reaches Reddit; Reddit has dropped the feed.

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
