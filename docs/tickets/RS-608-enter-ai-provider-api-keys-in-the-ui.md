---
id: RS-608
title: Enter AI provider API keys in the UI
type: story
status: done
priority: P2
created: 2026-11-23
reporter: jinhu
branch: session/ai-keys-ui
pr:
version: 1.475.0
related: [RS-607]
---

## Ask

> as we discuss that we control the apikey in our UI instead of the environments.

## Context

RS-607 (v1.474.0) made AI providers pluggable and models switchable on
Settings ▸ AI models, but the keys still came only from env vars
(`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) on the ERP
backend and on the Reddit tracker worker; the page only showed whether one was
set. The owner wants to paste and manage the keys on that page. Asked in
planning, the owner chose to have the ERP push a saved key to the Reddit
tracker as well, so every key lives in one place.

## Acceptance criteria

- [x] A manager pastes a key for OpenRouter, Anthropic or OpenAI on Settings ▸ AI models. It is tested before it is saved, and shown afterwards only as its last 4 characters.
- [x] Saved keys are stored encrypted, and model calls use them within 30 s.
- [x] A UI key wins over an env key, and removing it falls back to env.
- [x] The key reaches the Reddit tracker, whose workers use it within a minute; a failed push is visible and retryable.
- [x] No API response, log line or tracker settings read contains a full key.
- [x] Production with no key anywhere answers 502 for an AI read rather than returning stub data.

## Out of scope

Keys for anything other than the three AI providers. The Facebook
coordinator's `ai.py`, which keeps its own `OPENROUTER_API_KEY`.

## Notes

ERP keys are sealed with `lib/sealed.ts` under a key derived from
`FB_POOL_KEY` (label `ai-keys`). The tracker stores them in plain text in its
own `llm_keys` table, the same trust level as its Railway env vars.

Verified against mocked provider and tracker HTTP and a local Postgres: key
test, sealing, push, precedence over env, removal, and the production no-key
refusal. No real provider key was used.
