---
id: RS-312
title: Buyer alerts ask for a reaction, and the evaluator reasons before it decides
type: story
status: in-progress
priority: P2
created: 2026-10-19
reporter: jinhu
branch: reddit-reasoning-first
pr:
version:
related: [RS-305, RS-309]
---

## Ask

Chosen in reply to two questions: how buyers should learn that reactions now
count, and whether to build reasoning-first into the tracker.

> Hint line on each alert (Recommended)

> Yes: plan, build, deploy (Recommended)

## Context

- **Buyers react to nothing.** Lead data, which decides which Reddit prompt is
  better (RS-305, RS-309), comes only from reactions on alerts. In the first
  hours after RS-305 shipped, 15 alerts reached the buyers' group and none
  got a reaction. Nothing tells the buyers their reactions are counted now.
- **The verdict comes before the reasoning.** The offline evaluation
  (`trackers/reddit/docs/prompt-evaluations/2026-10-19-candidate-1-offline.md`,
  100 prod posts) measured what happens when the model gives its reasoning
  before its verdict. Precision against the written spec rose from 45% to
  57% for the live prompt, and from 75% to 85% for candidate 1. With the
  verdict first, the model often contradicts itself, e.g. "totaling 4 target
  items, which does not meet the minimum of 7" with `is_target: true`.

## Acceptance criteria

- [ ] Every buyer alert ends with "React 👍 if you act on this, 👎 if it's not
  useful." Dev-chat reviews keep their own reaction line and don't repeat it.
- [ ] The evaluator's response schema asks for `reasoning` before `is_target`,
  for live and candidate prompts alike.
- [ ] A prompt version's identity includes the response schema:
  - verdicts made under the old and new schema never share a version;
  - `prompt_versions.response_schema` labels each one;
  - `GET /api/prompt-stats` returns it.
- [ ] The ERP's **Which prompt is better** card labels each version
  *verdict first* or *reasoning first*.
- [ ] Run through the shipped code path, candidate 1 lands near 85%
  precision on the evaluation's 100 posts.

## Out of scope

- **Promoting candidate 1.** The user chose to keep the trial running until
  reactions confirm it.
- **Changing the model** (`openai/gpt-4o-mini`).

## Notes
