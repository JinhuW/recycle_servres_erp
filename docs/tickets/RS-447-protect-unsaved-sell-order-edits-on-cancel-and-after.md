---
id: RS-447
title: Protect unsaved sell-order edits on Cancel and after Save
type: bug
status: in-progress
priority: P2
created: 2026-10-28
reporter: jinhu
branch: fix/sell-order-unsaved-edits
pr:
version: 1.377.2
related: [RS-441]
---

## Ask

> go ahead and fix them, then release to prod.

## Context

The review of the v1.375.0 sell-order editor found two ways to silently lose
unsaved edits. Cancel reloads the saved order without calling confirmDiscard.
After Save, the detail GET can finish after saving clears, replacing anything
typed while that GET was pending.

## Acceptance criteria

- [x] Cancel asks before discarding edits; declining keeps the draft intact.
- [x] Confirmed Cancel reloads the order in place.
- [x] The editor stays disabled during Save and until its detail reload settles.
- [x] A failed reload releases the controls and preserves the draft.
- [ ] Regression checks pass, and dev is released to production.

## Out of scope

Changing sell-order lifecycle rules or the listing monitors.

## Notes

Approved fix plan: restore the existing discard confirmation, disable form
controls across saves and detail refreshes, verify delayed/error responses,
then squash-merge the fix to dev and merge dev to main for the release.

Browser regression checks used intercepted API responses against the local
Vite app: decline and confirm Cancel; hold PATCH, then hold the detail GET;
check notes/quantity/price/status/receiver controls; fail the detail GET and
confirm the draft remains editable. All passed. Typecheck, production build,
1,214 frontend tests and seven Worker proxy tests passed.
