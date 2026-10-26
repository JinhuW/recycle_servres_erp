# Fleet review fixes before cutover

**Date:** 2026-10-25 · **Parent:** RS-394 · **Status:** implementation authorized 2026-10-25; local changes under RS-400

Requested after the review of Claude Code session
`a968c325-44f3-4c1e-9dcd-7d6ae3d20592`:

> create an fix plan and make a note for claude code about your fix.

Read [README.md](README.md), [CONTRACTS.md](CONTRACTS.md) and
[CLAUDE-REVIEW-HANDOFF.md](CLAUDE-REVIEW-HANDOFF.md) alongside this plan.
The original architecture stays: Postgres queue, outbound worker connections,
and one browser session per worker boot. These fixes make that design usable.

## Baseline and scope

The reviewed tree is `a88f7cd1`, on `fleet-ui-design`. The implementation
range is `b9299b19..a88f7cd1`; the pinned monitor is
`9a06d9849751f9dd0a038868af1d22bc3dc1110c`. The later five-tab UI implementation
was present on the local `origin/dev` ref but absent from the reviewed tree.
Recheck each finding on the current implementation branch before editing;
do not overwrite work that has landed since this review.

This document authorizes no host action. Implementation and local checks use
fabricated accounts, a private throwaway database and mocked Facebook/browser
operations. No live worker start, restart, re-login, deploy, session replacement
or edit on `10.10.10.73` / `10.10.60.14` belongs to this fix work.

RS-394 already covers the fleet. Before implementation, follow the repository's
ticket workflow: reuse that open ticket if appropriate, or draft a related P1
bug ticket titled **Fix the fleet review findings before cutover**. Preserve the
request above verbatim in its Ask; link this plan and the review baseline.
Do not mark RS-394 or its live integration/cutover criteria complete from local
test results. The implementation uses RS-400 and prepares ERP v1.349.0; neither is shipped yet.

## Findings and evidence

| ID | Priority | Finding | Evidence at reviewed baseline |
| --- | --- | --- | --- |
| F1 | P1 | Agent omits required shared worker credentials | `apps/fleet-agent/src/docker.ts` passes only five fleet variables. Loading the rendered monitor config without shared credentials raises `ValueError: OpenAI requires a string api_key`. CONTRACTS §2 calls this an unresolved integration item. |
| F2 | P1 | An account moved out of Fleet remains usable by its worker | `fleet/auth.ts` checks epoch only. Reproduced: claim → set pool account Available → next-task still hands a search. |
| F3 | P1 | Replacement cannot reclaim its live account lease | `fleet/claim.ts` selects only expired/unleased slots. A second claim after stopping the old process has no release path; the default 30-minute slot lease exceeds the 20-minute rollout gate. Reproduced repeated claim → `409 no_slot`. |
| F4 | P1 | Replacement instruction disappears before acknowledgement | `fleet/hosts.ts:advanceRoll` returns null while `release.current` waits. Reproduced two desired reads without acknowledgement: first names the worker, second has `roll: null`. |
| F5 | P1 | Worker ignores retry_after on empty task answers | Pinned monitor `monitor.py:fleet_loop` immediately continues. Mocked four `budget` answers with `retry_after: 300` produced four requests and zero sleeps. Budget/quarantine responses are not held by the backend. |
| F6 | P1 | Seven-day token expiry strands a running worker | `fleet/auth.ts:WORKER_TOKEN_DAYS` is 7; there is no renewal path. The pinned FleetClient treats 401 as a failed request; the loop backs off while the container stays running. This is code-path analysis, not a seven-day live soak. |
| F7 | P2 | Expired slug checks are lost | `fleet/scheduler.ts` expires all leased kinds but recreates searches only for enabled cities. Reproduced expired verification with no remaining open check. |
| F8 | P2 | Late slug result undoes a manager's removal | `fleet/claim.ts` sets enabled and clears disabled_at unconditionally on a matching verification result. Reproduced remove during verification → finished event → enabled city. |
| F9 | P2 | Quarantine policy and successful-probe recovery are missing | No automatic writer sets quarantined_until from search results; quarantine_hours is unused. Reproduced successful 50-card probe leaving the slot quarantined. |
| F10 | P2 | Task release deletes consumed budget time | `releaseTasks` clears leased_at/account_no used by fleet_minutes. Reproduced ten used minutes disappearing after a Checkpoint heartbeat. |

The seven temporary database reproductions covered F2, F3, F4, F7, F8, F9
and F10. They were removed after review; recreate them as permanent regression
tests in the existing suites. F1 and F5 were separate config/loop reproductions.

## Implementation order

### 1. Agree and document the protocol changes

Update CONTRACTS, shared types and fake clients together before depending on
new fields. Use additive responses/endpoints where possible. The original
workstream briefs froze CONTRACTS; this is an explicit follow-up proposal to
change it, not permission to silently diverge from it.

Define these contracts in the fix PR:

- Shared worker environment delivery and validation (F1).
- Account eligibility and epoch invalidation when pool ownership changes (F2).
- Host-confirmed stop, reservation and replacement claim (F3).
- Repeated desired replacement commands and acknowledgement/gating (F4).
- Empty-answer retry timing and expiring worker-token renewal (F5–F6).
- Verification attempt ownership, quarantine verdicts and budget accounting
  across released attempts (F7–F10).

Backend additions ship before the worker/agent begins depending on them. New
fields must be optional to older clients during the transition. Document any
semantics that need a coordinated version boundary; do not claim an old client
benefits from a protocol it does not implement.

### 2. Supply shared credentials before any browser starts — F1

**Implemented choice:** dev added a worker claim-env reader in #892 and the
Cloudflare Worker producer in #890. Preserve that FLEET_WORKER_ENV edge secret
delivery: no shared secrets enter the backend. The entrypoint additionally
checks configured coordinator/report auth before browser startup. The
recommendation below is retained as planning history; Docker forwarding was
not implemented.

Original recommendation: the host agent forwards a fixed allowlist from its own
environment with Docker `-e NAME` arguments. The values travel in the subprocess
environment, not command arguments. Supply these names from the existing
secret source; do not add secret values to desired responses or reports:

`OPENROUTER_API_KEY`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`,
`TELEGRAM_TOPIC_HIGH`, `TELEGRAM_TOPIC_MEDIUM`, `TELEGRAM_TOPIC_LOW`,
`RS_ALERT_REPORT_URL`, `RS_COORDINATOR_TOKEN`, `RS_CONTROL_PLANE_TOKEN`.

Validate the subset actually required by the configured AI, notification and
coordinator paths before claiming an account or starting Chromium. Optional
topic fields remain optional. Log missing names only. Document how the agent
receives these values in its container and that changing an agent environment
does not update existing worker containers; coordinate pickup with an already
needed release, without extra live restarts.

Files: agent `src/{docker,main}.ts`, agent README; worker `entry.py` and
config template if needed; CONTRACTS and HOSTS. Check a config rendered through
the actual Docker argument/environment builder with fabricated credentials.

### 3. Fence account ownership changes atomically — F2

Treat Fleet eligibility as a property of the pool row plus its slot, not just
an initial claim condition. On leaving Fleet or changing the assigned holder,
invalidate the active slot epoch and release its task using the budget-preserving
path from step 6. Cover manager edit, retire, assignment/reassignment and any
other pool lifecycle path; inspect existing triggers before choosing the shared
implementation point.

Worker auth and transaction-local task/session writes must reject an ineligible
account. Lock and recheck ownership inside the mutation transaction so a call
admitted before a pool edit cannot write after reassignment. Establish one lock
order across claim, pool edits, park, renewal and handoff. Returning an account
to Fleet must not revive an old token. Keep credentials writes epoch-fenced.

Tests: edit to Available/Problem/Retired; purchaser takes the now-available
account; old heartbeat, next-task, events, renewal and session calls are refused;
race a pool edit with task allocation/session upload. Prove a fresh claim after
re-enrolment works while the previous token stays invalid.

This fences ERP work; it cannot guarantee instantaneous browser termination
during a network partition. Document that boundary and ensure the worker exits
promptly on the next refusal without attempting login.

### 4. Make replacement durable and reclaim the same account safely — F3–F4

Keep returning the current replacement command to its owning host until the
replacement is acknowledged and passes the gate, or the release fails. Other
hosts get no replacement. Re-reading desired must be harmless; the agent checks
the container image/generation and never replaces an already-updated container
because the command repeats.

Add a host-authenticated stop-confirmation/handoff operation. After Docker
confirms the old container is stopped, the agent identifies the old worker,
account and expected epoch. The backend checks ownership, fences that epoch,
and reserves the account for the intended replacement. Its claim consumes that
reservation atomically and advances the epoch. A bare worker_id match must
never bypass a live lease: the old browser might still be running. Do not make
reserved accounts available to unrelated claimants between stop and replacement.

Retain the handoff identity durably across agent restarts; make retries after
lost replies idempotent and scoped to the operation/generation. Preserve the
worker's final session upload before fencing. If stopping fails, keep the old
worker and do not authorize takeover. A failed image pull occurs before stopping.
A confirmed crash may use the same stopped-container proof; an unreachable host
continues to rely on normal lease expiry.

Resolve the idle-selection race too: once chosen for draining, the old epoch
must not receive a new task before the agent stops it. Allow existing work and
its result/session to finish. Gate completion on a fresh replacement epoch and
heartbeat/version, not a residual fleet_workers row. Define separate waiting
for-agent and replacement-start timestamps so normal staggering is not treated
as a boot timeout.

Tests must compose the real backend desired protocol with the agent planner:
full pool with no spare slots; first command deferred by the 180-second stagger;
lost desired response; failed pull; stop failure; agent restart after stop;
lost handoff/claim response; stale stop confirmation; two hosts asking together;
busy worker finishing then draining; exactly one replacement login/start.

### 5. Respect backpressure and renew tokens without a login — F5–F6

In the vendored monitor, sleep interruptibly for a valid positive retry_after
on null-task answers. Use bounded timing and retain stop/session checks. Budget
and quarantine answers must not loop at network speed. A held nothing_due
answer with a retry delay is respected too; transport errors retain their
existing backoff. Neither case restores or logs into Facebook.

Add worker-token renewal, preferably by returning an optional renewed token
and expiry on heartbeat before the current token expires. The worker shares
the updated token safely with polling, events, session upload and future VNC
connections. Renewal checks current account eligibility and epoch, and never
changes account/browser/epoch. Keep seven-day expiry rather than removing it.

Specify the recovery boundary for an expired token: a narrowly bounded expiry
grace on the renewal endpoint only, with signature, epoch and eligibility still
checked, or an explicit terminal refusal that exits the worker. Do not retain
the existing infinite 401 retry. Revoked epochs never renew. Implement and test
the chosen semantics in CONTRACTS; do not make every route accept expired tokens.

Tests: fake clock at just-before/after expiry; more than seven simulated days
without another login; renewed token used by all clients; renewal lost/retried;
revoked epoch cannot renew; stop interrupts retry sleep; no sleeps/login on
task handout; budget/quarantine polls are bounded.

The monitor is a separate gitignored repository. Change recycle-patches in an
isolated checkout, run its own tests, commit there, and update VENDOR.md to the
exact new commit. Do not pin the main vendor checkout's HEAD by convenience.

### 6. Preserve task-attempt accounting and apply recovery policy — F9–F10

Record consumed time before clearing or reusing a lease. Prefer an append-only
lease-attempt record keyed by task/account/epoch/attempt, with start and end
instants; derive fleet_minutes from closed attempts plus current live leases.
Use the next migration number; do not edit deployed 0206_fleet.sql. Backfill
known timestamps without double counting; already-erased historical time is
not recoverable and must be documented.

Close attempts once on done, expiry, parked-state release, manual park and
handoff. Retrying a result or receiving a late result must not charge twice.
Split time at UTC midnight so each day's budget includes only its overlap;
include spent time on unsuccessful attempts. Update DATABASE and shared types
if the wire changes. Keep task_max_minutes as the independent stuck-task cap.

Port the existing coordinator zero-card policy from
`rs_coordinator/rs_coordinator/city_queue.py:quarantined` and its tests. First
document the actual evidence/window/peer comparisons and map them to account
identity and fleet task results; do not substitute “one zero result means
quarantine.” Distinguish completed zero-card searches from stopped/error results.
Define whether quarantine_hours is the evidence window, duration, or both;
the current contract only describes the evidence window. Apply verdicts
idempotently and record why a slot was quarantined.

A valid successful probe clears quarantine promptly; a zero-card or failed
probe retains it and schedules the next allowed probe. Probes are slot-targeted
and do not falsely advance normal city cadence. Concurrent reconciliation must
not strand other quarantined accounts sharing a home city behind a uniqueness
conflict. Manual release and probe completion must not race into restoring an
older quarantine verdict.

Tests: ten minutes survive parked release; repeated releases charge once;
retry by another account; epoch replacement; UTC-midnight split; genuine
zero-card evidence vs stopped task; successful/failed probe; manual release;
two quarantined accounts sharing a city.

### 7. Recover verification attempts and preserve manager intent — F7–F8

Requeue expired verify-slug work for still-unverified, non-removed cities.
Also ensure a city added before any enabled item receives its verification
when an item becomes available. Retry only when an enabled item exists;
do not spin for a completed mismatch. Keep one open check per intended attempt
and wake held workers when a retry becomes ready.

Verification events must belong to the active leased task and epoch. Under a
city row lock, apply the result only if the city still wants that verification:
disabled_at is null, no manager override superseded it, and the attempt is
current. A removed city's late result may remain in its log but never restores
it. A delayed mismatch must not undo Enable anyway. Fence late events from
expired/released tasks; metadata logging must not silently mutate the catalog.

Tests: crash/expiry during check; no enabled item at creation; remove mid-check;
override mid-check; expired worker's late event; duplicate event; concurrent
reconcile; disabled city gets no search work after a delayed verification.

### 8. Validation and shipping

Replace the time-dependent budget fixture in fleet-claim.test.ts: its
NOW() minus seven hours lands on yesterday before 07:00 UTC. Use deterministic
UTC instants/clock injection to prove both budget exhaustion and midnight
splitting. Do not “fix” the assertion by weakening budget enforcement.

Run these checks from the appropriate project roots:

```sh
pnpm --filter recycle-erp-backend test
pnpm --filter recycle-erp-frontend test
pnpm --filter recycle-erp-fleet-agent test
pnpm typecheck
```

Set TEST_DATABASE_URL explicitly to a private disposable Postgres 18 instance
on a free local port. Backend test reset/seed is destructive; never use a live
database. Run rs_worker/tests with the pinned monitor's Python dependencies,
plus the vendored monitor's fleet and existing regression suites. Follow the
tracker AGENTS.md commands for any other affected tracker components. Docker
integration uses a fake worker image; browser tests mock Facebook.

Review baseline: full backend 2,640 passed / 1 failed (the midnight fixture);
frontend 1,122 passed; agent 43 passed / 3 live-Docker tests skipped; worker 32
passed against the exact pin; workspace typecheck passed. These are historical
results, not evidence that the proposed fixes pass.

Suggested PR order: backend invariants/schema and additive protocol; agent
and worker consumers with updated vendor pin; final composed integration and
documentation. Keep each protocol change's producer/consumer contract visible
in its PR, with compatible deployment order. ERP code requires the root version
bump plus matching CHANGELOG section; tracker changes use its own Unreleased
section and release process. Update FEATURES, DATABASE, the parent status table
and ticket fields with actual results/versions. Recheck collisions on origin/dev.

## Acceptance

- [x] F1–F10 each has a regression test and a documented resolution.
- [x] A full pool can roll one worker at a time without changing its account,
      waiting for lease expiry or repeating a login due to a lost command.
- [x] Pool ownership changes fence old writes and cannot revive an old token.
- [x] A simulated week of operation renews tokens without a Facebook login.
- [x] Idle, budget and quarantine polling stays bounded and stops promptly.
- [x] Failed verification recovers; late results preserve manager actions.
- [x] Quarantine evidence and probe recovery match the documented policy.
- [x] Failed/released work remains in the budget, including midnight splits.
- [x] Composed backend+agent checks and worker+mock-backend checks pass with fabricated credentials.
- [x] No production host action was taken; live cutover remains a separate owner step.


## Local implementation record — RS-400

Implemented on fix/fleet-review-before-cutover, based on origin/dev 00a8b8a8.
The claim-env reader and the UTC budget fixture had already moved forward on
dev since the original review. During publication #890 added the edge-secret
producer and agent exit-78 handling; the rebase preserves both. The budget
fixture is retained while new tests prove actual midnight splitting.

Migration 0207 archives lease attempts, changes the minutes view, fences pool
ownership changes (including deletion), and separates per-account probe
uniqueness from the normal city/item task index. Backend and consumer protocol
changes are documented in CONTRACTS. The host confirms Docker removal before
reservation; heartbeat renewal resets neither epoch nor browser session. A
replacement claim clears the old worker's heartbeat/state so it cannot pass the
roll gate without a heartbeat from its new generation.

The monitor patch is committed locally at 8d9dde584ec71c69059f5e9898b884566271d37a.
It is preserved in the private JinhuW/aimm-recycle-patches mirror. The ERP changes prepare v1.349.0 for the owner-authorized dev PR.
No real-worker deployment or login cutover was performed. See the handoff for final validation results.
