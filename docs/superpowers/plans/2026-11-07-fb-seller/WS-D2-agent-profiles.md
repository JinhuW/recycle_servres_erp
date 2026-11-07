# WS-D2 — Agent profiles, shadow runs and replay tests

What makes the agent safe to change: versioned profiles, a candidate that runs
in shadow, saved cases replayed against any version, and a side-by-side
compare. CONTRACTS §6.3, §6.4, §6.7 are the spec.

## Owns

- `src/routes/fbAgent.ts`, `src/services/fbAgentProfiles.ts`, `src/services/fbAgentEval.ts`.
- `apps/backend/tests/fixtures/fb-agent/` (hand-written cases) and tests `apps/backend/tests/fb-agent-profiles-*.test.ts`.

## Do

1. **Profiles**: list, read, new draft from any version, edit draft (params validated against D1's registry schemas — call `agentRegistry()`; until D1 merges, validate against a local copy of the CONTRACTS §6.5 table and swap at rebase), promote (candidate/active, one transaction, the one-active/one-candidate indexes hold), retire, roll back (promote an earlier version).
2. **Shadow listing**: `GET /shadow` pairs each shadow run with the live run of the same trigger message; show both decisions.
3. **Cases**: CRUD; `saveCaseFromThread(tx, threadId, name, expected)` freezes the thread's current `AgentInput` (messages + Market snapshot + offer settings) so the case replays the same tomorrow.
4. **Eval runs**: background, one `decide` per case with the profile (D1's `decide`, real `AgentLlm`), stored as `fb_agent_runs` rows with `eval_run_id`/`eval_case_id`; pass/fail against `EvalExpectation`; counted against `agent.daily_spend_usd`.
5. **Compare**: two eval runs → per case: hand-off yes/no, reason kind, offer, reply text, pass/fail, changed or not.
6. **Seed cases** (fixture file + a seed step a manager can run from the page, not a migration): at least one per rule, plus clean screening and a 3-round negotiation that ends in a closing hand-off.

## Exit criteria

- [x] Tests: a draft is the only editable state; promote/retire/rollback keep exactly one active; params invalid for a rule's schema are refused with the field named.
- [x] Tests: a candidate in shadow never writes to a thread or queues a message.
- [x] Tests: replaying a saved case twice with a stubbed LLM gives identical decisions; Market changes after saving don't change the replay.
- [x] Tests: compare reports changed cases correctly.
- [x] Version bump, CHANGELOG, README Status.

## Outcome

v1.439.0. Notes for the workstreams after D2:

- `agentRegistry()` is a copy of the §6.5 table in `fbAgentProfiles.ts`; swap
  it for D1's `fbAgent/registry.ts` export when D1 merges.
- `agentLlmFor` and `agentSpentTodayUsd` were added to D1's stub `index.ts` as
  throwing stubs (CONTRACTS §9); D1's bodies win at merge.
- `saveCaseFromThread` freezes the thread's current messages and offer
  settings, and takes `market` from the thread's newest live run's input (what
  the agent last priced it with), `[]` when it has none.
- Seed cases are in `src/services/fbAgentSeedCases.ts` (tests are not in the
  image); `POST /api/fb-agent/cases/seed` adds the missing ones. The keyword
  case passes only once a profile's keyword rule lists a matching pattern.
- `tests/fixtures/fb-agent/stubAgent.ts` holds the stubbed LLM and a small
  contract-shaped `decide` the tests replay with.
- An eval stuck in `running` by a process restart stays so; nothing retakes it.
