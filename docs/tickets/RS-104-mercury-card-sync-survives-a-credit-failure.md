---
id: RS-104
title: Mercury card sync survives a /credit failure
type: bug
status: in-progress
priority: P1
created: 2026-09-24
reporter: Jinhu
branch: fix/mercury-credit-review
pr:
version:
related: [RS-103]
---

## Ask

> /code-review high dev -> prod. Fix any issue and release to main.

## Context

The pre-release review of v1.176.0 (RS-103, Mercury IO credit card sync) found
that one failed `/api/v1/credit` call undid the fix: the own-account set was
built only from accounts fetched that run, so card payoffs fell back to
`external` and the card spend counted twice again. The one-shot backfill
(0134) only worked if `/credit` succeeded on the first sync after deploy, and
a card left out of a run pinned `MIN(sync_cursor)` for the whole source.

## Acceptance criteria

- [ ] A `/credit` failure leaves card payoffs classified `transfer` (own ids come from `bank_accounts` too).
- [ ] An account seen for the first time is fetched from at least as far back as the source's oldest start or row, so a missed first run still backfills the card.
- [ ] Each account syncs from its own cursor; a card missing from a run holds only its own window.
- [ ] A card whose transaction fetch fails is dropped for that run without costing the bank feed.
- [ ] A known card that is no longer `active` is still fetched.
- [ ] `/accounts` and `/credit` are fetched concurrently.

## Out of scope

- Transfers tile counting both legs of a payoff: checking↔savings moves already count twice; the tile counts rows.
- Migration gap at 0133: held by open PR #391 (RS-095); 0134 already ran on dev.
- A pending card authorization that expires without a status change: unverified (prod has no card rows yet). Check prod for card rows pending 7+ days after release.

## Notes

Plan: `~/.claude/plans/happy-cuddling-summit.md`.
