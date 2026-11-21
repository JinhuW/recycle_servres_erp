---
id: RS-600
title: Reddit alerts drop a seller's second lot when one is DDR3 and the other DDR4
type: bug
status: done
priority: P2
created: 2026-11-20
reporter: jinhu
branch: fix/reddit-dedup-memory-generation
pr: "#1234"
version: "tracker c68b2c66, Railway api+worker deployed 2026-11-21; OCI fleet pending"
related: []
---

## Ask

> Help me review the redditapi monitoring new alerts design. seem it may miss some post when a same person make a post for ddr3 and other postfor ddr4. it will miss one pos.

> go ahead and release the change.

## Context

The notify loop runs every target through the cross-post dedup in
`trackers/reddit/src/dedup.ts` (`findAlertedCopy` → `isSameListing`), which
treats two posts by one author within 72 h as one listing when their titles
are similar enough, or, across subreddits, when their bodies are. The losing
post is parked as `duplicate` for good and `/api/matches` hides duplicates, so
the miss was silent.

`ddr3` vs `ddr4` was only one differing word. Titles that share sizes or
server models (`Server RAM DDR4 RDIMM 32GB 64GB` / `… DDR3 …`,
`RAM pulled from Dell R720 R730 servers - DDR4` / `… DDR3`) passed the title
thresholds, and a DDR3 lot and a DDR4 lot cross-posted with one template body
passed the body match regardless of title.

## Acceptance criteria

- [x] Two posts that both name a memory generation (DDR2–DDR5, LPDDR, DDR3L,
      `PC3-…`/`PC4-…`) with none in common are never the same listing.
- [x] The generation is read from title and body, so bare titles
      (`Server RAM`) with differing bodies stay apart.
- [x] A real cross-post naming one generation still pairs.
- [x] Regression cases in `trackers/reddit/tests/dedup.test.ts`.

## Out of scope

- Module-type conflicts (RDIMM vs LRDIMM vs UDIMM): same class of risk, not
  reported; left for a follow-up if seen.
- Two posts with identical bare titles and no distinguishing body still pair:
  nothing in the text tells them apart from a repost.
- Auditing past `duplicate` rows in production.

## Notes

Generations are compared on title ∪ body words, unlike makers and quantities,
which stay title-only: a template body rarely names a generation the seller
isn't selling in that post.
