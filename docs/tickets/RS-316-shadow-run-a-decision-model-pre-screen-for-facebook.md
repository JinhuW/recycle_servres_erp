---
id: RS-316
title: Shadow-run a decision-model pre-screen for Facebook listings
type: task
status: backlog
priority: P2
created: 2026-10-19
reporter: jinhu
branch: fix/rs-316-prescreen-shadow
pr:
version:
related: [RS-311]
---

## Ask

> create a plan to fix them:
>
> Found on the way, not fixed
>
> - is_visible(timeout=…) is ignored by Playwright 1.64, so every such "wait" in poster/messenger/monitor is an instant snapshot.
> - Messenger's send check (get_by_text(...).last) may ack an unsent reply.
> - Challenge screenshots write outside the coordinator's data volume (RS_SCREENSHOT_DIR unset): none from past checkpoints survived.
> - Phase 2 candidate: a decision-model pre-screen in front of the listing LLM, after a shadow run against ai_eval history.

## Context

RS-311 left the listing LLM alone because the alert needs text back (summary,
unit count). It flagged a pre-screen as phase 2, after a shadow run. The index
says the prize is large: over the 14 days to 2026-10-19 the fleet logged about
58k `ai_eval` events, 11k of them billed model calls (~780 a day), and 126
scored 4 or higher. A decision model that rejects the obvious misses before the
LLM sees them would drop most of those calls, but only a replay against the
recorded verdicts says what it costs in recall.

Two gaps for a replay: the `ai_eval` event carries title, price and the first
2000 characters of the description but not `unit_count`, `quantity` or the model
id, so the unit-count gate cannot be judged offline; and no script replays or
shadows evaluations today (`scripts/eval-keywords.py` parses log lines for a
different purpose).

Plan: `docs/superpowers/plans/2026-10-19-rs311-follow-ups.md`.

## Acceptance criteria

- [ ] The `ai_eval` event carries `unit_count`, `quantity` and `model` (additive fields).
- [ ] `scripts/prescreen-shadow.py` pulls recent billed `ai_eval` events from OpenSearch, asks a Decisions-API model one `choice` question per listing (`reject` / `maybe` / `buy`), and prints, per threshold on P(reject), the share of calls saved, the recall of score ≥ 4 and ≥ 3, latency and cost, plus every score-4+ listing a threshold would have dropped.
- [ ] The report for two models (`openai/gpt-6-luna-decisions`, `typesafe/jev-1.14`) is pasted below, with a go/no-go call against the rule: some threshold keeps ≥ 99% of score-4+ listings while dropping ≥ 50% of billed calls.

## Out of scope

- The live gate itself (`RS_PRESCREEN_MODEL`, `listing_skip reason=prescreen`). It is a follow-up ticket if the shadow run passes.
- Changing the LLM prompt or thresholds.

## Notes

