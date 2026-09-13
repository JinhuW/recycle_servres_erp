---
id: RS-048
title: Facebook tracker shows the fleet's accounts, coverage and search phrases
type: story
status: done
priority: P2
created: 2026-09-13
reporter: Jinhu
branch: feat/fleet-dashboard
pr: 282
version: 1.140.0
related: []
---

## Ask

The original ask is not in the repo: #282 was written on 2026-09-06 in a
session that filed no ticket, and its wording survives only in that session's
transcript.  What is on record is the decision that shipped it — on
2026-09-13, told that #282 had sat open since 2026-09-07 with its version taken
and conflicts against `dev`, and offered leave-open / revive / close, Jinhu
chose:

> Revive and merge it

## Context

The `/fleet` page answered "is a worker alive?" and nothing else.  The operator's
actual question is which Facebook account is searching which cities for which
phrases, and whether it is alive — plus, when something is wrong, everything
about that account's identity and environment without opening the homelab.

The rs-console facade in `facebook_tracker` composes that as one document
(`/v1/fleet`) and serves a standalone dashboard from it.  This change forwards
that document (and the alert-hit stats) through the existing manager-only
`/api/coordinator` proxy and renders it as cards in the ERP's own desktop shell,
built on the same tokens and class names so the two stay in step.  See #282
for the full design record.

## Acceptance criteria

- [ ] `/fleet` as a manager shows fleet KPIs (accounts live, cities searched
      now, active phrases, open checkpoints), an accounts table with one row
      per Facebook account, the per-item search phrases, the search settings,
      and the coverage map by region.
- [ ] A row expands to the city list, vault account, stored secret names,
      browser identity, backup age, proxy env var, session file, pacing, and
      the worker's build.
- [ ] The page-head search filters accounts, cities and phrases at once, with
      matches highlighted.
- [ ] With the facade route absent (as on a local stack) the fleet cards show
      "fleet view unavailable" and checkpoints, review volume and the filter
      prompt keep working.
- [ ] `en` and `zh` strings are in parity.

## Out of scope

Deploying the facade route itself — it ships with the next `facebook_tracker`
release, independently of this repo.

## Notes

#282 was rebased onto today's `dev` rather than re-cut: its conflicts were only
`CHANGELOG.md`, `package.json` and an appended block in `desktop.css`.  Version
1.129.0 → 1.140.0; this ticket was filed at revival time, since the PR predates
the ticket workflow being enforced.
