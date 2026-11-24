---
id: RS-612
title: AI provider keys and default model set only in the UI
type: task
status: done
priority: P2
created: 2026-11-23
reporter: jinhu
branch: feat/rs-609-ai-settings-ui
pr:
version: 1.479.0
related: [RS-607, RS-608]
---

## Ask

> update the agents, for future development for all secrets or configuration. Try to integrate in the UI instead of environments.

> So for this feature. Let we optimize the implementation to update the setting to the UI instead of setting in the environment variable.

("This feature" is the RS-607/608 AI provider keys and model settings.)

## Context

After RS-607/608 (v1.475.1), AI keys and models can be set on Settings ▸ AI
models, but env vars still acted as a hidden second source. On the ERP
backend, `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` were
fallback keys, and `AI_MODEL` / `OPENROUTER_OCR_MODEL` were the fallback
model. The Reddit tracker read the same three keys. During the release this
made the tracker's `api` and `worker` services disagree: one had an env key
and the other didn't. The new AGENTS.md rule (env vars are for bootstrap only)
applies here.

## Acceptance criteria

- [x] At ERP boot, each env key is imported once into `ai_provider_keys`
  (sealed) and pushed to the tracker. `AI_MODEL` / `OPENROUTER_OCR_MODEL`
  seeds `ai_models.default` only when it is empty.
- [x] The import runs once (`workspace_settings.ai_env_imported`). A key
  removed on the page, or one with a pending tracker removal, is never
  re-imported.
- [x] With no sealing key, the import logs an error, imports nothing, and
  boot goes on.
- [x] After the import, the ERP reads keys and the default model only from
  the database. An env key alone no longer counts as configured.
- [x] Settings ▸ AI models shows an imported key like any saved one, with no
  "from env" state or env-var hints.
- [x] The Reddit tracker imports its env keys into `llm_keys` once, and a
  removal from the ERP is never undone by a leftover env var. GET
  `/api/llm-keys` reports `source: 'stored' | null`.

## Out of scope

Deleting the now-ignored env vars on Railway, which needs the owner's
go-ahead after deploy. The Facebook coordinator's `ai.py` and its own
`OPENROUTER_API_KEY`.

## Notes

Plan: `~/.claude/plans/adaptive-popping-karp-of-9a878c65-f378-46b4-839f-c5a662b8e89e.md`.
Planned as RS-609 / v1.476.0. Both numbers went to the eBay work first, so
this is RS-612 / v1.479.0.

- ERP marker: `workspace_settings.ai_env_imported` = `{providers, model, at}`,
  written in the same transaction as the imported rows, under an advisory
  lock so two instances booting together don't both import. It is refused by
  PATCH /api/workspace. With no sealing key and an env key present, no marker
  is written, so the import runs once `FB_POOL_KEY` is set.
- `AI_MODEL` is imported only when its provider ends up with a key. Before,
  an env model with no key gave way to a keyed provider's default, and an
  imported one keeps that behaviour.
- `ai_provider_keys` has no note column, so imported rows are recognisable by
  `updated_by IS NULL` and the import log line rather than a note.
- Tracker marker: table `llm_keys_env_imported` (migration 0011), one row per
  provider, because its processes boot with different env (the api had no
  key, the worker had one). A provider is imported by whichever process has
  its key first, and never again.
- Verified by tests, not by a local boot against Railway-like env.
