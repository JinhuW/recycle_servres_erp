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

- [ ] Tests: a draft is the only editable state; promote/retire/rollback keep exactly one active; params invalid for a rule's schema are refused with the field named.
- [ ] Tests: a candidate in shadow never writes to a thread or queues a message.
- [ ] Tests: replaying a saved case twice with a stubbed LLM gives identical decisions; Market changes after saving don't change the replay.
- [ ] Tests: compare reports changed cases correctly.
- [ ] Version bump, CHANGELOG, README Status.
