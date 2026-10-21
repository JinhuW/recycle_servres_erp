---
id: RS-316
title: Shadow-run a decision-model pre-screen for Facebook listings
type: task
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: fix/rs-316-prescreen-shadow
pr: 777
version: facebook-tracker 0.13.1
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

- [x] The `ai_eval` event carries `unit_count`, `quantity` and `model` (additive fields).
- [x] `scripts/prescreen-shadow.py` pulls recent billed `ai_eval` events from OpenSearch, asks a Decisions-API model one `choice` question per listing (`reject` / `maybe` / `buy`), and prints, per threshold on P(reject), the share of calls saved, the recall of score ≥ 4 and ≥ 3, latency and cost, plus every score-4+ listing a threshold would have dropped.
- [x] The report for two models (`openai/gpt-6-luna-decisions`, `typesafe/jev-1.14`) is pasted below, with a go/no-go call against the rule: some threshold keeps ≥ 99% of score-4+ listings while dropping ≥ 50% of billed calls.

## Out of scope

- The live gate itself (`RS_PRESCREEN_MODEL`, `listing_skip reason=prescreen`). It is a follow-up ticket if the shadow run passes.
- Changing the LLM prompt or thresholds.

## Notes

Shadow run on 2026-10-19 over the 14 days to that date: 11,099 billed verdicts
(793 a day); sampled all 93 that scored 4+ and all 32 that scored 3, plus 1,453
random 1-2s (each standing for 7.5). Full reports:
`assets/RS-316-shadow-gpt-6-luna-decisions.md`, `assets/RS-316-shadow-jev-1.14.md`.

| model | per call | gate at P(reject) ≥ 0.99: calls saved | 4+ kept | 4+ dropped |
|---|---|---|---|---|
| `openai/gpt-6-luna-decisions` | 191 ms, $0.00013 | 44.7% | 97.8% | 2 of 93 |
| `typesafe/jev-1.14` | 170 ms, $0.00006 | 79.8% | 98.9% | 1 of 93 |

**Verdict: no-go on the rule as written.** Neither model keeps 99% of the
score-4+ listings at any threshold that saves half the calls. Jev misses by one
listing, and that listing ("2x8 sticks of samsung 3200 ddr4 laptop ram", LLM
score 5) is two modules, which the purchasing rules reject; the other 4+
listings Jev is most sure are rejects are a whole Dell R740xd, an i7 bundle
with one 16 GB module, and a "brand new sealed" A-Tech kit. On a read of those
rows the decision model is applying the rules and the LLM is not. So the honest
reading is: the rule measured agreement with the LLM, and the LLM's 4+ set
contains false positives the pre-screen would correctly drop.

What would make a go case: hand-label the 93 score-4+ listings (worth buying or
not) and re-run `--replay` against that label instead of the LLM score. If Jev
at 0.99 keeps every true positive, a live gate (`RS_PRESCREEN_MODEL`,
`listing_skip reason=prescreen`, off by default) is a follow-up ticket, and
would cut the LLM bill by about four fifths for about $0.05 a day.

Jev is the better pre-screen here (fewer 4+ dropped at every threshold, half
the price) even though Luna Decisions won the page-state probe in RS-311: the
two tasks differ, and `RS_PAGE_CHECK_MODEL` stays as it is.
