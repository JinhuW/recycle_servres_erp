# Claude Code handoff: fleet review fixes

**Date:** 2026-10-25 · **Related:** RS-394

The owner asked Codex to review the implementation based on Claude Code
session `a968c325-44f3-4c1e-9dcd-7d6ae3d20592`, then requested:

> create an fix plan and make a note for claude code about your fix.

**Implementation update:** the owner authorized the fixes on 2026-10-25.
RS-400 implements F1–F10 locally on `fix/fleet-review-before-cutover`, preparing
ERP v1.349.0 in [PR #901](https://github.com/JinhuW/recycle_servres_erp/pull/901)
to dev. No real Facebook worker deployment is included. See [REVIEW-FIX-PLAN.md](REVIEW-FIX-PLAN.md) for the proposed
implementation, reproduction evidence, dependencies and acceptance checklist.

## Start here

1. Read root AGENTS.md / CLAUDE.md, the backend and tracker AGENTS.md files,
   this folder's README and CONTRACTS, then the fix plan.
2. Inspect your actual branch and diff. The review baseline was `a88f7cd1`
   on fleet-ui-design, not the latest dev. Do not reset or change this
   worktree's branch to begin implementation. Use scripts/new-session.sh
   for your own implementation branch/worktree based on origin/dev and
   carry these two documents into it if they have not landed there yet.
3. Revalidate the findings on that tree. In particular, the five-tab UI
   rework was outside this review; preserve any newer work and report which
   findings were already resolved, citing commits and tests.
4. Follow the ticket/plan workflow before code. The later request “continue and start the fix implementation” approved
   implementation. Live deployment still requires the owner’s separate approval.
   RS-394 is the parent. The fix plan includes a proposed related bug-ticket
   title and the exact requester text if a separate ticket is needed.

## Fix priorities

- First unblock startup: pass the required shared worker environment.
- Fence pool ownership changes, preserve budget accounting, and define a
  stopped-container handoff so replacement reuses its account safely.
- Repeat replacement commands until acknowledged; compose backend and agent
  tests so the start stagger and lost replies cannot stall a release.
- Fix retry_after handling and add token renewal across every worker client.
- Retry lost slug checks, guard late results against manager changes, and
  complete quarantine detection plus successful-probe recovery.
- Replace the UTC-time-dependent budget test fixture.

Use F1–F10 from the fix plan in your completion report. Some fixes change
CONTRACTS; revise the contract and consumers together and ship backend support
first. The plan recommends approaches; finalize precise payloads, migration
numbers and lock order against the latest code before implementation.

## Evidence and environment notes

- Seven temporary Vitest reproductions confirmed F2/F3/F4/F7/F8/F9/F10.
  They were removed; add permanent tests to the existing suites.
- F1 was reproduced by rendering/loading the config with the agent's actual
  environment contract: OpenAI requires a string api_key.
- F5 was reproduced with the pinned monitor loop and mocked budget responses:
  four answers with retry_after 300, zero sleeps.
- F6 was established by tracing expiry and 401 handling, not a live soak.
- The reviewed monitor pin was `9a06d9849751f9dd0a038868af1d22bc3dc1110c`.
  The main vendor checkout had a newer HEAD; it was deliberately not used.
  Patch an isolated recycle-patches checkout, test it, commit it and update
  VENDOR.md to its exact commit. Never push patches to upstream origin.
- Review dependencies were installed with pnpm. A disposable Postgres 18
  container named codex-fleet-review-pg on port 55509 was used and removed.
  Do not assume that database, Python venvs or temporary vendor archive exists
  in your session. Build your own test environment and use fabricated secrets.
- Full backend baseline: 2,640 pass / 1 failure in the budget fixture before
  07:00 UTC. Focused fleet baseline: 74 pass / that same failure. Frontend:
  1,122 pass. Agent: 43 pass / 3 live-Docker skips. Worker: 32 pass. Typecheck
  passed. Re-run appropriate checks after fixes; these are review-only results.

## Boundaries

No live Facebook login, restart, deploy, re-login, session replacement or host
config edit was performed. Keep implementation and verification login-free.
The root account-safety rule and WS-F's owner-approved cutover steps still
apply. Do not mark real-worker integration or cutover complete from mocks.

The initial review ended with a clean worktree. Implementation now includes
code, tests and documentation in the separate worktree described above. No commit, push or message to another Claude session is implied by this
note. Deliver actual fixes through the repository's normal PR-to-dev process
when implementation is requested, with versions, changelog, features and ticket
updates appropriate to the paths changed.


## Implementation details for the next session

- Worktree: `/Users/jinhu/Projects/recycle_servers_v2/recycle_servres_erp/.claude/worktrees/fix-fleet-review-before-cutover`.
- Ticket: RS-400; migration: 0207_fleet_recovery.sql; prepared root version:
  1.349.0. Recheck these numbers against origin/dev before a PR.
- F1 preserves #890's Cloudflare Worker FLEET_WORKER_ENV secret delivery and
  #892's claim-env reader. The entrypoint additionally validates configured
  coordinator/report credentials before browser startup. No backend secret
  storage or agent Docker-env forwarding is required. Real secret provisioning
  is outside this change.
- F2 uses a pool lifecycle trigger plus account/slot locks on worker writes;
  F10 records closed lease attempts and splits their UTC-day overlap.
- F3/F4 persist stop identities in /state, confirm Docker removal, then reserve
  the same account by handoff_epoch. Claims are idempotent by claim_id; a new
  boot cannot consume an already-used reservation. Draining blocks new tasks.
- F5/F6 honor retry_after and renew through heartbeat before token expiry.
  Expiry is terminal (401 → exit 75); there is no expired-token grace. The
  worker's private token file updates future relay connections.
- F7/F8 recover verification and apply verdicts only to the still-leased
  attempt/epoch, respecting removal and override. F9 ports the zero-card rule,
  records evidence and resets it on manual release or a positive probe.
- Exit 78 is now left stopped by the agent, matching dev's operator-parked worker.
- Vendor commit: `8d9dde584ec71c69059f5e9898b884566271d37a`, in this worktree's separate
  `trackers/facebook/ai-marketplace-monitor` clone. It is pinned in VENDOR.md and preserved in the private
  JinhuW/aimm-recycle-patches mirror.
  Never push it to upstream. The original main vendor checkout is unchanged.
- Deploy backend protocol/schema support before updating the agent/worker.
  Keep /state durable. Existing live browsers cannot pick up new entrypoint
  code without a release, which remains a separately approved operation.


## Local validation before the publication rebase — 2026-10-25

All runs below used the implementation worktree and fabricated credentials.

| Check | Result |
| --- | --- |
| Full backend suite, private Postgres 18 | 2,709 passed across 247 files |
| Focused fleet regressions | 94 passed across 5 files |
| Frontend suite | 1,154 passed across 94 files |
| Agent unit/integration suite | 45 passed; the 3 opt-in Docker cases skipped in this run |
| Agent opt-in real Docker suite | All 3 passed separately, using an Alpine sleep image |
| rs_worker suite | 42 passed |
| Vendored monitor unit suite | 573 passed, 1 skipped |
| Vendored monitor local HTML browser suite | 5 passed in a separate process |
| Coordinator/poster/messenger suites | 726 passed, 31 optional cases skipped |
| Workspace typecheck | Passed |
| Tracker vendor pin and credential scan | Passed |
| git diff --check | Passed |

The monitor's local HTML browser tests and unit tests need separate pytest
processes in this environment: the session-scoped Playwright event loop conflicts
with an unrelated notification test's asyncio.run when combined. No test code
was changed to hide that failure. Extra test dependencies were installed under
/tmp/codex-fleet-fix-testdeps; existing main-checkout venvs were not modified.
The tracker suites used explicit current-source PYTHONPATH entries and
--import-mode=importlib to avoid stale editable installs and duplicate test names.

The final full backend run used unchanged source for the duration of its run;
its log was /tmp/fleet-fix-backend-stable.log. Earlier runs made while code/version
files were being edited are not the final evidence above. Other local logs use
/tmp/fleet-fix-*.log. The disposable database was codex-fleet-fix-pg on port 55519;
it was removed after validation. The Docker smoke suite cleaned up its own sleep
containers and image. No real Facebook worker, account session or remote host
was started, restarted or edited.

## Publication and remaining live operations

The owner authorized publication to dev. The vendor commit 8d9dde584ec71c69059f5e9898b884566271d37a
is preserved in the private JinhuW/aimm-recycle-patches mirror. Migration 0207
and ticket RS-400 remain free on dev. Concurrent PR #890 took v1.348.0, so
this change was rebased and renumbered to v1.349.0 for PR #901. The rebase also
preserves #902's tracker 0.14.0 release; these tracker changes remain Unreleased. Preserve newer UI work; never push the monitor fork to
upstream. Provision the Cloudflare Worker's FLEET_WORKER_ENV through the normal
secret-management path without logging values.

Deploy backend schema/protocol support first. Real worker releases and live
cutover still require the owner's separate approval under root AGENTS.md.


## Publication validation after rebasing onto dev

The final ERP/backend and agent sources passed: backend **2,708 tests** across
247 files; frontend **1,154**; agent **50** plus all **3** opt-in Docker cases;
rs_worker **42**; Cloudflare proxy **5**; workspace typecheck. The removed test
was for the superseded backend-secret producer: shared secrets stay at the edge
under #890, whose proxy tests pass. The monitor patch is unchanged from the full
vendor validation above. Vendor pins, the full tracked-file credential scan and
diff whitespace checks pass. The temporary Postgres instance for this rerun is
codex-fleet-publish-pg on localhost port 55519 and is removed after validation.
GitHub PR checks gate the merge to dev; this does not authorize a worker release.
