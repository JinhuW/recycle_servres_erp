---
id: RS-606
title: Fix the bugs found by the 2026-11-22 workspace review
type: bug
status: in-review
priority: P2
created: 2026-11-22
reporter: owner
branch: fix/review-2026-11-22
pr:
version: 1.473.1
related: []
---

## Ask

> Fan outs agent to fix the bugs first.

## Context

A fan-out review of the whole workspace on 2026-11-22 verified 320 findings.
This ticket covers the "fix first" bugs that live in the ERP monorepo. The
extension, reddit_marketing, home_page and ram4cash fixes are on branches in
their own repos.

## Acceptance criteria

- [x] Sell-order attachments, accounting attachments and receipt scans accept files over 1 MiB.
- [x] A failing tracking-number registration is logged, never crashes the backend.
- [x] `pnpm db:reset` replays every migration on an already-migrated database.
- [x] Discarding a transfer keeps a sell order's link to the moved units.
- [x] The inventory PATCH audit records only what was written.
- [x] Follow-lines refuses an archived PO.
- [x] Follow-up dates, Home dates and package ETAs use the Denver day; fleet "Today (ET)" uses the Eastern day.
- [x] Phone PO: no duplicate line on a second Save tap, typeable total cost, payer change counted as unsaved, no 30-row cap. Market dialog refuses a blank price.
- [x] Fleet agent replaces a worker whose old container could not be removed, and exits promptly on SIGTERM.
- [x] `pnpm dev` runs backend and SPA only; version-check no longer misreads large diffs; backend-tests path filters cover the files tests read.
- [x] Facebook tracker: poster/messenger split proxy credentials; `release.sh --dry-run` works in any position; `deploy.sh` no longer reports workers it never checked.

## Out of scope

- The backend manual market-price route still accepts 0; only the dialog refuses it.
- `evidence.ts` write routes still skip the archived check.
- Rewriting `trackers/facebook/scripts/deploy.sh` and its docs for the fleet-agent setup (needs the owner's decision on rs-fleetd).
- Requiring status checks in GitHub branch protection (a repo setting).

## Notes

Review report: https://claude.ai/artifact/4L6kqSHpwENVMMdTnhkuUF
