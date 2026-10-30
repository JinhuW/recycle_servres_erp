---
id: RS-466
title: Fix the dev→main review findings: alert sender, verdict bridge, agent replacements, Free rows
type: bug
status: in-review
priority: P2
created: 2026-10-30
reporter: jinhu
branch: JinhuW/rs-466-review-fixes
pr:
version: 1.387.1
related: [RS-453, RS-455, RS-456, RS-461, RS-463]
---

## Ask

> /code-review high dev to main. fix all issue and release to prod.

## Context

A high-effort review of `origin/main...origin/dev` (RS-453 to RS-464) found
ten issues: four in the homelab stopgap scripts, two in the fleet agent's
release replacements, one in the Workers table's Free status, and three of
stale docs or duplicated code.

## Acceptance criteria

- [x] `fleet-alert-sender.py` records a listing as soon as Telegram takes
  its message, and a failed coordinator call after that only retries the
  report, never the send.
- [x] It records only a `duplicate` claim as final. A `pending` claim, which
  is another worker's lease and may lapse, is asked about again next pass.
- [x] Its withheld query is collapsed per listing and newest first, so a
  window with more withheld lines than a page never drops the new ones.
- [x] It mints a worker token again when the coordinator answers 401.
- [x] `ai-verdict-bridge.py` re-indexes a doc into the daily index that
  already holds its `_id`, so a line stamped across midnight is not counted
  twice.
- [x] A release replacement takes a tick's start before every other run or
  restart. A missing worker the ERP refuses a ticket can no longer starve it.
- [x] A worker above the count that was stopped for its replacement, and
  whose run then failed, keeps its account reserved and is run again. It is
  no longer quietly removed.
- [x] A stopped worker of a deleted host reads Parked on the Workers table,
  not Free.
- [x] The capacity comments no longer say the agent removes workers above
  the count. The four tables share one `nextSort`.

## Out of scope

Existing duplicate verdict docs in OpenSearch stay. The two sort comparators
stay separate (natural order with a stable index, against `localeCompare`).

## Notes

The owner dropped the Removed status in RS-463, so a worker of a deleted host
reads Parked rather than bringing that status back.
