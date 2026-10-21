---
id: RS-325
title: Reddit page picks the evaluation model from OpenRouter's catalogue
type: story
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: reddit-model-picker
pr: "#790"
version: 1.298.0
related: [RS-322, RS-309]
---

## Ask

> I hope this will be a dropdown menu or auto fill the model name from openrouter.

(With a screenshot of the trial dialog's free-text Model field.)

## Context

RS-322 added the live-model dialog as a free-text OpenRouter id, the same
shape as the trial dialog's model field (RS-309). OpenRouter publishes its
catalogue at `GET /api/v1/models` without a key: about 470 models with name,
context length, price per token and the parameters each supports. The
evaluate loop asks for strict JSON (`response_format`), which only models
advertising `structured_outputs` can give, so the catalogue also says which
models can do the job.

The browser cannot reach openrouter.ai (CSP, and every call goes through
`lib/api.ts`), so the ERP backend fetches the list, trims it and caches it
for an hour. The frontend already has a Combobox for "type anything or pick
from the list"; the tracker dialogs use it with the catalogue as the list. A
typed id the list lacks is still accepted (new models appear before anyone
updates the ERP), guarded by the same `provider/model` check.

## Acceptance criteria

- [x] `GET /api/ai/models` (manager-only) returns `{ models: [{ id, name, contextLength, promptPerM, completionPerM, structuredOutputs, inputModalities, outputModalities }], fetchedAt }`, trimmed from OpenRouter's catalogue, cached in-process for an hour, single-flight, and served stale when a refresh fails. A first fetch that fails is a 502 naming OpenRouter.
- [x] The live-model dialog and the trial dialog show a combobox listing the models that support structured outputs and produce text, with the price per million tokens and context length beside each id; typing filters by id.
- [x] A typed id not in the list is still accepted ("Use …" row); both dialogs refuse an id that is not `provider/model`.
- [x] While the catalogue loads the menu says so; if it cannot be loaded the field works as free text with a hint saying the list is unavailable.
- [x] The menu is not clipped by the modal.
- [x] Tests: the route trims and caches (second call does not refetch), serves stale on failure without retrying on every read, 502 on a cold failure, purchaser gets 403.
- [x] `docs/FEATURES.md` cites the version.

## Out of scope

- The PO AI review model (Settings ▸ General) and the Facebook fleet `ai_model`: same picker later; the endpoint already carries the flags they need (image input for the receipt scan).
- Validating the id against the catalogue on save: new models appear before anyone updates the ERP, and the tracker still validates the shape.
- Pricing or capability checks on the tracker side.

## Notes

- OpenRouter lists about 19 floating aliases (`~anthropic/claude-haiku-latest`). The tracker dialogs leave them out: an alias swaps the model under an unchanged prompt version, which would blur that version's score, and `MODEL_ID` refuses the `~` anyway. The list the evaluator dialogs show is 374 models (2026-10-19).
- Router entries (`openrouter/auto`) carry a price of -1; the backend reports their price as null and the picker omits it.
- Neither modal can let an absolutely placed menu escape on its own (`.modal-shell` clips, `.modal-body` scrolls). The live-model dialog holds one field, so its shell and body let the menu hang past the footer. In the trial dialog the Model field moved above the prompt, so its menu opens over the textarea inside the scrolling body. The shared Combobox is unchanged.
- After a failed refresh the stale copy is served for five minutes before the next attempt, so an OpenRouter outage doesn't cost each dialog open a 10 s timeout.
