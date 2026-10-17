---
id: RS-274
title: Fix the release review findings on Fleet rules, city chips and the pool picker
type: bug
status: in-progress
priority: P2
created: 2026-10-17
reporter: jinhu
branch: fix/release-review-findings
pr:
version: 1.271.3
related: []
---

## Ask

> /code-review high. fix all issued and merge to main.

## Context

The `/code-review high` pass over the pending `dev` → `main` release (RS-265 to
RS-273, facebook-tracker v0.6.1) found two bugs that could push wrong keyword
rules to every worker, one release-order hazard that would grey every city chip,
and a handful of smaller ones.

## Acceptance criteria

- [x] Enter in the Fleet flow's "Try a listing" inputs does not submit the stage's settings form.
- [x] Adding `"solid state"` or `"m.2"` to a keyword group saves `… OR "solid state"`, not a re-quoted term that never matches.
- [x] City chips fall back to the worker's liveness when the facade serves no `today.cities` (null or absent), so the ERP can ship before the tracker.
- [x] A reorder-only edit counts as one change, so Save can send it.
- [x] The pool editor's worker picker disables a worker that already holds another fleet account.
- [x] The holder help text names a worker ID when the status is Fleet; one change reads "1 unsaved change".
- [x] `ruleLines`/`termKey` are the one copy of their rules, and `ruleShape` is cached per rule string.

## Out of scope

The vendored monitor pin `37da00f` (VENDOR.md) is missing from this machine's
v2 `ai-marketplace-monitor` checkout. It lives on the local-only
`recycle-patches` branch, apparently in the older
`~/Projects/recycle_servers/facebook_tracker/` checkout; fetching it across is a
manual step outside this repo.
