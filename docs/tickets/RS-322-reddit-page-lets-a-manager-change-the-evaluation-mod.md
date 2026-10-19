---
id: RS-322
title: Reddit page lets a manager change the evaluation model
type: story
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: reddit-tracker-model-settings
pr: "#786"
version: 1.295.0
related: [RS-309, RS-299]
---

## Ask

> The reddits should also have the abilities to adjust the models.

(With a screenshot of the Evaluate stage and its rule list.)

## Context

The tracker stores the evaluation model as the `llm_model` setting and
validates it on `PUT /api/settings/llm_model` (an OpenRouter id,
`provider/model`); every worker picks a change up within 60 s through the
settings cache. The ERP proxy (`apps/backend/src/routes/tracker.ts`) keeps
`/settings` unproxied on purpose, so the Reddit page shows no model at all.
The only way to change it from the ERP has been a candidate trial plus
promote (RS-309, v1.291.0), which also switches every rule off.

The Facebook fleet page already edits its `ai_model` in place, and the trial
dialog already takes a free-text OpenRouter id, so the pattern exists. The
proxy opens exactly one key; generic settings stay closed.

## Acceptance criteria

- [x] The Evaluate stage shows a **Model** chip with the live OpenRouter model id.
- [x] A manager can edit it in a dialog; save sends `PUT /api/tracker/settings/llm_model {value}`; the chip updates and a toast confirms.
- [x] The dialog refuses an id that does not match `provider/model`; the tracker's own 400 passes through as the error.
- [x] The proxy forwards only `PUT /settings/llm_model`. `GET /settings`, `PUT /settings/eval_prompt` and any other key still 404 without calling the tracker. Tests cover both.
- [x] Promoting a candidate refreshes the chip (promote rewrites `llm_model`).
- [x] Contract tables in root `AGENTS.md` and `trackers/reddit/AGENTS.md` list the new route; `docs/FEATURES.md` cites the version.

## Out of scope

- The candidate model: the trial dialog already sets it.
- The base `eval_prompt` and any other setting (RS-309 kept them out; still true).
- A model picker fed by OpenRouter's catalogue. Free text, as everywhere else in the ERP.
- The mobile shell, which has no tracker page.
- A new tracker route to read the model back: the page reads it from `prompt-stats`, which is already proxied.

## Notes

- No tracker code changes: `PUT /api/settings/:key` and its validation already exist, so there is no deploy-ordering concern.
