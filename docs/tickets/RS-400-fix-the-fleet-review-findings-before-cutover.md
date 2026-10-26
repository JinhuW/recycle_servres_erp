---
id: RS-400
title: Fix the fleet review findings before cutover
type: bug
status: done
priority: P1
created: 2026-10-25
reporter: jinhu
branch: fix/fleet-review-before-cutover
pr: 901
version: 1.349.0
related: [RS-394]
---

## Ask

> continue and start the fix implementation

Earlier planning request:

> create an fix plan and make a note for claude code about your fix.

## Context

Implement the ten fleet review findings in
[the fix plan](../superpowers/plans/2026-10-24-erp-fleet/REVIEW-FIX-PLAN.md).
Baseline dev: 00a8b8a8; revalidate changes since the review at a88f7cd1.
At review time the worker lacked shared env delivery; #892 and #890 subsequently
added the claim reader and Cloudflare producer, preserved in this implementation.

## Acceptance criteria

- [x] F1: shared worker credentials reach a rendered config before browser startup.
- [x] F2: pool ownership changes fence worker calls and writes atomically.
- [x] F3/F4: confirmed-stop handoff preserves the account; replacement commands survive retries.
- [x] F5/F6: retry delays are respected; tokens renew without another login.
- [x] F7/F8: lost slug checks recover; late results preserve manager intent.
- [x] F9: documented zero-card evidence quarantines accounts; successful probes release them.
- [x] F10: released attempts remain charged, split at UTC midnight.
- [x] Regression suites and local composed integration pass using made-up accounts.

## Out of scope

Live worker logins, restarts, deployments, host edits and production cutover.

## Notes

User approved implementation on 2026-10-25. Use a separate worktree and branch;
retain the newer five-tab UI and worker parking behavior from dev.


Implementation is published to dev through PR #901 as ERP v1.349.0, migration 0207 and
vendor commit 8d9dde584ec71c69059f5e9898b884566271d37a. The vendor commit is preserved in the private
JinhuW/aimm-recycle-patches mirror. The ERP change targets dev;
no real Facebook worker deployment is part of this request.
Do not mark the parent live-cutover criteria done from this local validation.


Final publication validation: backend 2,708 passed; initial focused fleet regressions 94 passed; frontend 1,154
passed; agent 50 plus 3 real-Docker smoke cases passed; worker 42 passed; monitor
573 unit plus 5 local HTML browser cases passed (1 optional skip); tracker
coordinator/poster/messenger 726 passed (31 optional skips). Cloudflare proxy 5 passed. Workspace typecheck,
vendor pin, credential scan and diff whitespace checks passed. See the handoff
for commands/environment notes. Publication to dev was authorized by the owner on 2026-10-25.
