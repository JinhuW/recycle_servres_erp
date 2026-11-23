---
id: RS-604
title: Reddit tracker: monitor all 13 subreddits again; move Railway config off railway.toml
type: bug
status: done
priority: P2
created: 2026-11-22
reporter: jinhu
branch: fix/reddit-monitors-railway
pr: "#1238"
version: "tracker, Railway api+worker deployed 2026-11-23"
related: [RS-601, RS-603]
---

## Ask

> 1. i think you can create multiple monitoring instead of stop due to one limit
> 2. fix the railway issue.

(Reply to a report that msp, pcmasterrace and minerswap were not on the
redditapis.com monitor, and that Railway stops reading `railway.toml` on
2026-12-01.)

## Context

Only 8 of the 13 subreddits were producing posts. On 2026-11-18 the vendor
refused msp, pcmasterrace and minerswap for its service-wide cap on
never-watched subreddits. On 2026-11-20 (RS-601) those three plus
bostonforsale and ewastescrap were disabled because they showed `HTTP 404`.
That status was left over from the dead RSS poll, not from the subreddits, so
the webhook was dropping bostonforsale and ewastescrap posts the vendor did
deliver.

Railway's CLI warned that `railway.toml` is ignored from 2026-12-01. The two
services' own settings said `RAILPACK`, so without the file the next deploy
would have stopped using the Dockerfile.

## Acceptance criteria

- [x] All 13 subreddits are enabled and on the vendor monitor.
- [x] A deploy with no `railway.toml` builds both services from the Dockerfile.

## Out of scope

- A second vendor monitor. The cap that refused the three subreddits is
  service-wide per never-watched subreddit, not per monitor (one monitor takes
  50), and the retry on 2026-11-22 got all three in.

## Notes

`.railway/railway.ts` now sets both services to the Dockerfile builder; it was
applied with `railway config apply` and `railway.toml` is deleted. The file
covers the whole project, so Postgres and its volumes must stay listed.
Variables are unmanaged. `railway` is a dev dependency, so the production
image (`pnpm install --prod`) is unchanged.
