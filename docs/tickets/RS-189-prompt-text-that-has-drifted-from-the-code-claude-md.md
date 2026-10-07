---
id: RS-189
title: "Prompt text that has drifted from the code: CLAUDE.md facts, the session hook, MCP tool descriptions"
type: bug
status: done
priority: P2
created: 2026-10-07
reporter: jinhu
branch: dev-6
pr: 523
version: 1.219.1
related: [RS-188]
---

## Ask

> /claude-api prompt-audit
>
> pls fix all of them,.

## Context

A prompt audit of everything a model reads in this repo — `CLAUDE.md`, the
project skills and `/ticket` command, the SessionStart hook's injected text, the
MCP tool descriptions and the OCR prompts — found text that no longer matches
the code. Each finding was checked against the repository, not guessed:

- **CLAUDE.md facts the code has outgrown.** The OCR fallback is described as
  silent in prod, but `env.ts` refuses to boot prod without
  `OPENROUTER_API_KEY` and `/api/health` reports `providers.ocr`. "Postgres 16"
  where Railway prod and CI run 18 (`backend-tests.yml`). `.claude/` is said to
  be ignored except `settings.json`, but `.gitignore` also keeps `skills/` and
  `commands/`. "Frontend tests are sparse (~6 files)" — there are 64. The
  vitest option is `maxWorkers`, not `maxForks`. `README.md` repeats the
  Postgres 16 claim.
- **History the model can't act on**: the seven-weeks bypass-key story, the
  removed vendor bid portal, "don't bring back `__X__`" for a pattern no longer
  in `src/`, and two competing "read first" files.
- **Memory pointers from another checkout**: five link labels name memory files,
  and a bullet points at `~/.claude/projects/-srv-data-recycle-erp/memory/`.
  The links themselves resolve to specs in the repo.
- **`plan-first` named as a repo rule**, but the skill lives in user config,
  not in the repo.
- **The SessionStart hook** tells any session outside `.claude/worktrees/` that
  it "started in the SHARED main checkout" — including a linked worktree made
  by other tooling, which then gets told to create a second worktree.
- **MCP tool descriptions** that don't match the code:
  `search_sellable_inventory` describes lot-level commitment (units are
  reserved since the sell-commitment change, and archived POs are skipped);
  `create_sell_order_draft` lists "already on an open sell order" as an error,
  but drafts don't block one another, and uses an all-caps MUST the schema
  already enforces; `set_market_price` promises "the most recently updated"
  twin while its query had no `ORDER BY` (the scraper push in
  `lib/marketWrite.ts` was already fixed that way).

## Acceptance criteria

- [x] Each CLAUDE.md / README.md fact above matches the code.
- [x] The history sentences, memory pointers and `plan-first` naming are gone
      or restated as current rules.
- [x] The hook stays silent in a linked worktree and still speaks in the main
      checkout.
- [x] The three MCP descriptions state what the code does.
- [x] With two reference prices on one canonical part number,
      `set_market_price` and `get_market_value` use the most recently updated
      one (test).

## Out of scope

- The OCR JSON scaffolding (fence-stripping, the JSON re-ask in
  `ai/openrouter.ts`). On the default `openai/` model, JSON mode already
  guarantees JSON, but the documented Gemini rollback
  (`OPENROUTER_OCR_MODEL=google/gemini-2.5-flash`) still needs it.
- The OCR prompts' wording — they target an OpenAI model, so Claude prompting
  guidance doesn't apply to them.

## Notes

- Plan: `~/.claude/plans/deep-bubbling-shell.md` (reviewed before approval;
  the review added `get_market_value`'s ordering, README.md and two code
  comments that contradicted the OCR fix).
