# OpenRouter OCR Provider — Design

**Date:** 2026-05-15
**Status:** Approved (pending written-spec review)

## Problem

Label OCR currently has two providers behind one interface (`src/ai.ts`):
`stub` (deterministic canned extraction) and `workers-ai` (Cloudflare Workers
AI, Llama 3.2 11B Vision). Llama 3.2 11B Vision is weak at the core task —
reading small dense text on server-component labels (RAM part numbers, speed
grades, rank codes). Extraction accuracy is the product, so we are adding a
third provider that calls frontier vision models via OpenRouter and making it
the default.

A working reference implementation exists in the prototype repo
`git@github.com:JinhuW/recycle_servers_iventory_managements.git`
(`src/lib/openrouter.ts`, `config/models.json`). This design mirrors its
proven call mechanics and prompt disambiguation rules rather than reinventing
them.

## Decisions (settled during brainstorming)

- **Approach:** extract `src/ai.ts` into a `src/ai/` provider module
  (chosen over minimal-inline and OpenRouter-only).
- **Default provider:** OpenRouter, model `google/gemini-2.0-flash-001`.
- **Failure behavior:** fail-fast. No runtime cascade between providers.
- **`STUB_OCR` removed entirely.** Provider chosen by key/binding presence.
- Workers AI retained as a still-selectable provider.

## §1 Module structure

`src/ai.ts` becomes `src/ai/` (Node/Workers directory-index resolution keeps
`import { scanLabel } from '../ai'` and any `../ai` imports working — no
caller changes):

```
src/ai/
  index.ts        Public surface: scanLabel(), ScanResult, CONFIDENCE_FLOOR.
                   Houses pickProvider() + fail-fast orchestration.
  prompts.ts       PROMPT_BY_CATEGORY (+ reference disambiguation rules),
                   parseModelJson() (fence-stripping + loose JSON).
  stub.ts          STUB_BY_CATEGORY + stubScan() (incl. STUB_LOW_CONF).
  workers-ai.ts    workersAiScan() — current Llama 3.2 path, logic unchanged.
  openrouter.ts    openRouterScan() — new, modeled on the prototype.
```

`ScanResult.provider` widens to `'stub' | 'workers-ai' | 'openrouter'`. The
`label_scans.provider` column is free-text — **no migration required**.

Public surface re-exported from `src/ai/index.ts` so existing imports
(`scanLabel`, `ScanResult`, `CONFIDENCE_FLOOR`) are unchanged. Confirm no
other module imports symbols beyond these before deleting the old file.

## §2 Provider selection & fail-fast contract

`STUB_OCR` removed. `pickProvider(env)` precedence:

1. `OPENROUTER_API_KEY` set → `openrouter`
2. else `env.AI` bound → `workers-ai`
3. else → `stub`

`STUB_LOW_CONF` is retained — it only affects the stub path
(`STUB_LOW_CONF=true` → confidence 0.3, empty fields, for exercising the
manual-entry UI).

`STUB_OCR` cleanup touch points: `src/types.ts`, `wrangler.toml [vars]`,
`apps/backend/.dev.vars`, `apps/backend/.dev.vars.example`,
`tests/helpers/app.ts:9`, `README.md`.

**Fail-fast:** `openRouterScan` (and `workersAiScan`) throw on non-2xx
response, missing content, or unparseable JSON. `scanLabel` does not catch.
`src/routes/scan.ts` wraps the `scanLabel` call in `try/catch` and returns
`502 { error: 'label OCR failed — retry the shot' }`, mirroring the existing
upload-failure 502 at the top of the same handler. No cascade to another
provider; the field user retries the shot.

## §3 OpenRouter provider

Mirrors prototype `src/lib/openrouter.ts`:

- **Endpoint:** `POST https://openrouter.ai/api/v1/chat/completions`
- **Headers:** `Authorization: Bearer ${OPENROUTER_API_KEY}`,
  `Content-Type: application/json`,
  `HTTP-Referer: https://recycle-erp.local`, `X-Title: Recycle ERP`
- **Body:** `model` = `env.OPENROUTER_OCR_MODEL ?? 'google/gemini-2.0-flash-001'`,
  `temperature: 0.1`, `max_tokens: 1024`,
  `messages: [{ role: 'user', content: [ { type:'text', text: prompt },
  { type:'image_url', image_url:{ url:'data:<mime>;base64,<b64>' } } ] }]`
- **Image encoding:** base64-encode `imageBytes`; sniff leading magic bytes
  to pick `image/png` (`89 50 4E 47`), `image/webp` (`RIFF…WEBP`), else
  default `image/jpeg`.
- **Response parse:** `parseModelJson(content)` — trim, strip leading/trailing
  ```` ``` ```` / ```` ```json ```` fences, `JSON.parse`; on failure fall back
  to first `{…}` regex match and parse that. Throw if still unparseable.
- **Confidence:** parsed object → `0.85`. Unparseable / API error → throw
  (→ route 502). No silent `0.4` low-confidence result for OpenRouter.

**Prompt upgrade.** Fold the prototype's RAM disambiguation rules into the
existing `PROMPT_BY_CATEGORY.RAM`, keeping our current field schema and enum
values:

- Type from the PC code, never from speed:
  `PC2-`→DDR2, `PC3-`/`PC3L-`→DDR3, `PC4-`→DDR4, `PC5-`→DDR5.
- Classification from form factor: SODIMM→laptop-class, UDIMM→desktop-class,
  RDIMM/LRDIMM→server-class.

SSD / HDD / Other prompts are unchanged. Prompts remain shared across the
`workers-ai` and `openrouter` providers via `prompts.ts`.

**Out of scope (YAGNI):** the prototype's multi-module `{ "modules": [...] }`
response shape and multi-image input. `scanLabel` keeps its current contract
of one `ScanResult` per `(category, imageBytes)` call. Flagged as a possible
future feature, not built now.

## §4 Config changes

- `src/types.ts` `Env`: **add** `OPENROUTER_API_KEY?: string`,
  `OPENROUTER_OCR_MODEL?: string`; **remove** `STUB_OCR?: string`.
- `apps/backend/.dev.vars` and `.dev.vars.example`: remove `STUB_OCR`; add
  `OPENROUTER_API_KEY=` and a commented
  `# OPENROUTER_OCR_MODEL=google/gemini-2.0-flash-001`.
- `apps/backend/wrangler.toml`: remove `STUB_OCR` from `[vars]`; add a comment
  that `OPENROUTER_API_KEY` is set via `wrangler secret put`. Keep the `[ai]`
  binding (Workers AI remains selectable when no OpenRouter key is set).
- `README.md` environment section: replace `STUB_OCR` guidance with the
  key-presence selection rule; document alternative models
  (`anthropic/claude-sonnet-4.5`, `openai/gpt-4o`).

## §5 Testing

No scan/OCR tests exist today. Add `tests/scan.test.ts`:

- **Stub path** — `testEnv` (no key, no `AI`) → `provider:'stub'`, canned
  fields returned, `label_scans` row persisted.
- **STUB_LOW_CONF** — → `confidence:0.3`, empty `fields`.
- **OpenRouter path** — unit-test `openRouterScan` with a mocked global
  `fetch`:
  - valid chat completion → parsed fields, `provider:'openrouter'`;
  - response wrapped in ```` ```json ```` fences still parses;
  - non-2xx response → throws → scan route returns `502`.
- **`pickProvider` unit tests** — all three precedence branches
  (openrouter / workers-ai / stub).

Harness change: add an optional `env` override parameter to the `multipart()`
helper in `tests/helpers/app.ts` so the OpenRouter route path can be exercised
with a mocked fetch without mutating the shared `testEnv`. Remove the now-dead
`STUB_OCR: 'true'` line from `testEnv`.

## Risks / notes

- `OPENROUTER_API_KEY` is a Worker runtime secret (lives in `.dev.vars` /
  `wrangler secret`), distinct from the wrangler CF auth token in `~/.zshenv`.
- Real Cloudflare credentials and tokens were exposed in the working session
  earlier; roll the OpenRouter key and CF tokens before production.
- Image-storage stub remains in effect (Cloudflare Images unpaid) — unrelated
  to this change but means `scanImageId` stays a stub placeholder.
