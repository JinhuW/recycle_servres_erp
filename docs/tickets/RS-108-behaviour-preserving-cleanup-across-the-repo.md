---
id: RS-108
title: Behaviour-preserving cleanup across the repo
type: chore
status: in-progress
priority: P2
created: 2026-09-25
reporter: jinhu
branch: refactor/repo-cleanup
pr:
version:
related: []
---

## Ask

> Ultrathink review the entire code repo to see if any code can clean up,but do not affect any features.

> Fan out agents to reiew all different modules.

## Context

Eight read-only reviewers covered the backend orders domain, the other backend
routes, backend infrastructure, the frontend lib, the desktop PO pages, the other
desktop pages, the mobile and vendor shells, and tooling/tests. About 120 findings
came back; only the behaviour-identical ones are in scope. Plan:
`~/.claude/plans/rustling-fluttering-island.md`.

## Acceptance criteria

- [ ] No API response shape, error string, status code or UI output changes.
- [ ] `pnpm typecheck`, `pnpm build`, the backend suite and the frontend suite pass.
- [ ] Duplicated helpers are replaced by one shared copy; dead code is removed.

## Out of scope

Anything that changes behaviour or load: `Promise.all` batching of request reads,
N+1 insert batching, converting hand-rolled modals to `Modal`, search debounce,
the inventory refetch filters, the access-token TTL parse, router-level
`requireManager` on sell orders/customers, deleting release scripts, CI changes.
Untranslated OrderActivityLog strings and a possible stale `__genericErrorMessage`
are real issues but not cleanups; they need their own tickets.
