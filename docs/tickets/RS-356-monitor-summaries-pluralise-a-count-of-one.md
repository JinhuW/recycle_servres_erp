---
id: RS-356
title: Monitor summaries pluralise a count of one
type: bug
status: in-review
priority: P3
created: 2026-10-22
reporter: jinhu
branch: fix/monitor-summary-plurals
pr:
version: 1.317.1
related: [RS-351]
---

## Ask

> fix the remaining

(said after a check of v1.316.x on the dev site, which found the Reddit
workers summary reading "… 9 subreddits · 1 rules on", and memtrade's WeChat
report degraded by an expired Claude sign-in)

## Context

The monitors' toolbar summaries were whole sentences with plural nouns fixed
in the string: Reddit's `trkWorkersSummary` / `trkWorkersSummaryPosts` and
WeChat's `wxBoardSummary` (both RS-351), and Facebook's `fbcWorkersSummary` /
`fbcWorkersSummaryPosts` (older). Any count of one reads wrong: "1 rules on",
"1 workers", "1 buyers", "1 cities". Dev has exactly one Reddit rule enabled,
so it showed there first.

The same check turned up the `verify` skill still recommending backend port
8899. That is the port that collided with another session's backend in
`docs/debug-notes/2026-10-22-local-verify-reached-another-sessions-dev-server.md`.

## Acceptance criteria

- [x] Reddit's workers summary says "1 worker", "1 post in 24 h", "1 alert",
      "1 subreddit" and "1 rule on" when that count is one, and the plural
      otherwise.
- [x] WeChat's board summary says "1 buyer", "1 seller", "1 post" and
      "…/1 group" for a count of one.
- [x] Facebook's workers summary says "1 worker", "1 new post today",
      "1 alert in 7 days" and "1 city" for a count of one.
- [x] The zh text reads as before.
- [x] The `verify` skill checks a port is free before using it, confirms the
      health version is the worktree's own, and links the debug note.

## Out of scope

- memtrade's expired Claude sign-in. memtrade runs on the office Mac, outside
  this repo, and signing it back in is an interactive login there.
- A plural-rules extension to `t()`. The `…One` key pattern
  (`payMatchCountOne`, `bcRemainingOne`) covers these few counts.

## Notes

Each summary is now built from one key per segment, joined with ` · `, so a
singular needs no sentence for every combination of counts. Each call puts
its literal key first (`n === 1 ? t('kOne', …) : t('k', …)`), so
`tests/i18nCoverage.test.ts` still checks every key.

Checked on the local stack with the tracker and WeChat APIs stubbed. With
every count at one, Reddit read "1 worker · 1 post in 24 h · 1 alert ·
1 subreddit · 1 rule on" and WeChat "1 buyer · 1 seller · 1 post · 1/1
group". The usual counts kept their plurals, and the zh text was unchanged.
Facebook's summary takes the same shape, but its fleet document wasn't
stubbed, so its singular is covered by the code and typecheck only.

Drafted as RS-353 / v1.316.2. The Paid-by work (#826) reached `dev` first
with RS-353–355 and v1.317.0.
