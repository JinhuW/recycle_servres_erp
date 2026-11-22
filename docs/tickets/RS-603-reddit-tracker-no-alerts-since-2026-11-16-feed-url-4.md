---
id: RS-603
title: Reddit tracker: no alerts since 2026-11-16, feed URL 404
type: bug
status: in-progress
priority: P1
created: 2026-11-17
reporter: jinhu
branch: session/20261117-185940
pr:
version:
related: []
---

## Ask

> help me debug why reddit has not alerts since yesterday.
>
> Once you found teh root casue, fix it and release it

## Context

Starting around 2026-11-16, every poll failed with `reddit fetch failed
{"error":"HTTP 404"}`, and `GET /api/stats` showed `last_status: "HTTP 404"`
for all 13 subreddits. With no posts discovered, nothing reached evaluation
or Telegram. Reddit has withdrawn anonymous RSS: every feed URL form, on both
`www.reddit.com` and `rss.reddit.com`, single or multireddit, returns an Atom
"Not Found". See `trackers/reddit/docs/debug-notes/reddit-new-rss-404.md`.

## Acceptance criteria

- [ ] The tracker discovers new posts through a route Reddit still serves.
- [ ] `GET /api/stats` shows `last_status: "ok"` for the subreddits.
- [ ] Buyer alerts resume in Telegram.

## Out of scope

—

## Notes

Fix: app-only OAuth (`grant_type=client_credentials`) in
`trackers/reddit/src/redditOAuth.ts`, which reads
`oauth.reddit.com/r/a+b+c/new` and `/comments/<id>` when
`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` are set. Without them the tracker
falls back to the dead Atom feed, so it changes nothing until the credentials
land. The credentials come from a **script** app at reddit.com/prefs/apps. A
Devvit app from developers.reddit.com is something else and has no client
secret. Reddit says public API access ends by March 2027, so this buys months,
not a permanent fix.

Reddit's create-app page would not issue OAuth credentials, so on 2026-11-17
the requester chose the redditapis.com monitoring product (Growth, $49/month)
instead. It pushes each new post in the 13 subreddits to a signed webhook on
the tracker api (`src/webhook.ts`, migration 0009). `poll_source = webhook`
idles the poll loop, and the ops watch pages after 90 minutes with no delivery.
`scripts/redditapis-monitor.ts` sets up the vendor side. The OAuth path stays
as a fallback. The vendor scrapes Reddit and its terms put Reddit compliance
on the customer. The requester accepted that trade-off.

A first attempt switched `/new.rss` to `/new/.rss`. A 429 on the new path
looked like "the route exists", but once the rate limit cleared it 404'd like
the rest.

The worker's Railway log lines carried no message text, so the diagnosis came
from `/api/stats` and from probing Reddit by hand.

Filed as RS-600. Renumbered RS-603 on 2026-11-22: the id was also given to
the DDR3/DDR4 dedup ticket, which merged first. Commits before that date cite
RS-600 for this work.
