---
id: RS-605
title: "Reddit tracker: remove the RSS/Atom feed code"
type: chore
status: done
priority: P3
created: 2026-11-22
reporter: jinhu
branch: refactor/reddit-drop-rss
pr: 1241
version: tracker only, not deployed (prod runs poll_source = webhook)
related: [RS-600, RS-602]
---

## Ask

> clean up all code of using the reddit rss feeds. Cuz it does not support any more,

## Context

Reddit withdrew logged-out RSS in November 2026, so every Atom URL 404s
(`trackers/reddit/docs/debug-notes/reddit-new-rss-404.md`). Posts now come from
the redditapis.com webhook (RS-600). The tracker still kept the Atom fetcher
and parsers as the "no OAuth credentials" fallback for the poll loop and the
PM tracer: dead code that could only fail.

## Acceptance criteria

- [x] `src/reddit.ts` keeps only the shared post/comment shapes and the rate-limit header helpers; the Atom fetcher, URL builders, parsers and HTML-to-text go.
- [x] `src/redditOAuth.ts` is the only direct reader of Reddit (`fetchNewPosts`, `fetchComments`).
- [x] With `poll_source = reddit` and no `REDDIT_CLIENT_ID`, the poll loop sends nothing, claims nothing and logs one warning an hour.
- [x] The tests and fixtures move from Atom XML to OAuth JSON; the captured r/hardwareswap thread and the 9-post listing are kept, converted.
- [x] The README, AGENTS.md and `docs/DATABASE.md` no longer describe RSS as a live source.

## Out of scope

- The historical debug notes (`reddit-anonymous-json-blocked.md`, `reddit-new-rss-404.md`) and migration comments: they record what happened.
- `reddit_marketing/` (a separate repo) has its own Atom-feed reader; it gets its own change.

## Notes

- Production runs `poll_source = webhook`, so this changes nothing live.
