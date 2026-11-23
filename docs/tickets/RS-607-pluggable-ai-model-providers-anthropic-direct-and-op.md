---
id: RS-607
title: Pluggable AI model providers: Anthropic direct and OpenAI
type: story
status: done
priority: P2
created: 2026-11-23
reporter: jinhu
branch: session/20261123-110506
pr:
version: 1.474.0
related: []
---

## Ask

> help me optimize the current api provider apporach.
>
> For the api model provider. Help me add a new provider for claude code.
>
> At the meantime. I hope it can also allow me to suuport more model provider. like open ai.

> I hope we can use an UI to switch them.

> let me also able to switch the model if needed. a dropdown menu to select the model.

## Context

Every model call went to OpenRouter, wired straight into each caller: the
ERP's `apps/backend/src/ai/openrouter.ts` (label OCR, receipts, PayPal, serial,
PO AI review) and the Reddit tracker's `trackers/reddit/src/llm.ts`. The
provider was chosen only by whether `OPENROUTER_API_KEY` was set, and the model
picker listed OpenRouter's catalogue only. Asked in planning, the owner said
"claude code" means the Anthropic API called directly, and scoped the work to
the ERP and the Reddit tracker.

## Acceptance criteria

- [x] A model ref `anthropic:<id>` runs OCR, receipt/PayPal/serial reads and the PO AI review through api.anthropic.com; the same for `openai:<id>`.
- [x] Existing bare OpenRouter ids keep working unchanged.
- [x] Every model setting has a provider dropdown and a model dropdown listing only that provider's models.
- [x] Settings ▸ AI models shows each provider's key status and switches the default and per-feature model (scan, receipt, PayPal, serial) without a redeploy; a provider with no key can't be selected.
- [x] The Reddit tracker evaluates posts with an `anthropic:` or `openai:` ref using strict JSON output.
- [x] The PO review's web lookup works on all three providers.
- [x] A new provider is one file implementing `LlmProvider` plus one registry entry.

## Out of scope

The Facebook coordinator's `ai.py`. The Claude Code CLI / Agent SDK with
subscription auth. Changing any default model.

## Notes

Model refs are `<provider>:<model>`; a value without a known prefix is
OpenRouter, so stored settings need no migration.

Verified against mocked provider HTTP only (request shapes, retries, refusals,
cost). No call was made with a real Anthropic or OpenAI key; the first live
check is setting a key in Railway and picking a model on Settings ▸ AI models.
Settings are written through the existing `PATCH /api/workspace` (key
`ai_models`) rather than a new `/api/ai/settings` route.
