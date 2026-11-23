# Reddit withdrew anonymous RSS — every feed URL now 404s

**Discovered:** 2026-11-17, after a day with no buyer alerts.

## Symptom

From about 2026-11-16, every poll failed and no alerts went out. The worker
logged `reddit fetch failed {"error":"HTTP 404"}` every cycle, and
`GET /api/stats` showed `last_status: "HTTP 404"` for all 13 subreddits.
Nothing crashed, the api's `/health` stayed `ok: true`, and the Railway
worker's log lines arrived with empty message text.

## It is not a bad subreddit or a URL typo

Probed by hand from one IP on 2026-11-17, at least 40 s apart:

| URL | Result |
| --- | --- |
| `www.reddit.com/r/homelabsales/new.rss` | 404, Atom `<title>Not Found</title>` |
| `www.reddit.com/r/homelabsales/new/.rss` | 404, Atom Not Found |
| `www.reddit.com/r/<13 subs>/new/.rss` | 404, Atom Not Found |
| `rss.reddit.com/r/homelabsales+hardwareswap+homelab/new.rss` | 404, Atom Not Found |
| `rss.reddit.com/r/homelabsales+hardwareswap+homelab/new/.rss` | 404, Atom Not Found |

The 404 body is an empty Atom feed whose `self` link is
`https://rss.reddit.com/`: Reddit's own "feed gone" answer. A 429 in between
means only that the IP's bucket is spent, **not** that the route works. That
trap cost one wrong fix (switching `/new.rss` to `/new/.rss`).

## Cause

Reddit announced on 2026-09-30 that it was ending RSS feeds and public API
access
([TechCrunch](https://techcrunch.com/2026/09/30/reddit-is-killing-rss-feeds-ending-public-api-access-because-of-ai-bots/)).
Reader vendors put the `.rss` shutdown at 2026-11-13
([hushread](https://hushread.com/blog/reddit-rss-readers-still-working)).
The fleet's last successful polls were around 2026-11-16, consistent with a
staged rollout.

The anonymous JSON API was already 403'd
([reddit-anonymous-json-blocked.md](reddit-anonymous-json-blocked.md)), so
no logged-out route is left. The other logged-out paths were probed from the
office IP on 2026-11-20 and 2026-11-22, and none of them is a way back:

| Path | Result |
| --- | --- |
| `old.reddit.com/r/<sub>/new/` and `/new/.rss` | 302 to the login page |
| `www.reddit.com/r/<sub>/new/` (HTML) | 200, but an 8 KB `js_challenge` shell with no posts |
| `www.reddit.com/svc/shreddit/community-more-posts/new/?name=<sub>` | 403 block page |
| `/r/news/new.rss` | 404 like ours, so it is not about which subreddits we watch |

## How to tell next time

- Every subreddit failing at once with the same status is a platform change
  or a block, not one bad subreddit.
- Read the 404 body. Reddit's "Not Found" Atom feed means the route is gone.
- Probe one URL per ~45 s from one IP, and never read a 429 as "works".
