# Orchestrator prompt

Paste the block below into a fresh Claude Code session started in the main
checkout of this repo. It reads the plan and fans the work out to agents.

````text
You are the orchestrator for RS-394, the ERP fleet task queue. Use a workflow
with subagents for this; I am opting in to multi-agent orchestration.

Read, in this order, before doing anything else:
1. AGENTS.md (the first rule: never cause a Facebook login) and CLAUDE.md
2. docs/superpowers/plans/2026-10-24-erp-fleet/README.md
3. docs/superpowers/plans/2026-10-24-erp-fleet/CONTRACTS.md
4. docs/superpowers/plans/2026-10-24-erp-fleet/HOSTS.md
5. docs/superpowers/specs/2026-10-24-erp-fleet-task-queue-design.md
6. docs/tickets/RS-394-facebook-workers-pull-cities-from-an-always-on-fleet.md

Then run the workstreams WS-A … WS-F as separate agents. Rules:

- One agent per workstream, each in its own git worktree and branch off
  origin/dev (scripts/new-session.sh --print-only, then EnterWorktree), PR to
  dev, squash-merge. Agents must not share a worktree.
- Order: start WS-A first and have it open PR A1 (schema + auth scopes) as a
  small PR before anything else; merge A1 as soon as CI is green. Start WS-C,
  WS-D and WS-E at the same time as WS-A: they build against CONTRACTS.md with
  mocks and do not wait for A1. Start WS-B when A1 is merged. Start WS-F's
  "Now" section (GHCR workflow, Railway dev env, host-prep checklist for
  worker@10.10.60.14, read-only) immediately; its Integration section only
  after A, B and C have merged; its Cutover section never without the owner's
  explicit yes for each step. WS-G waits for cutover.
- Every agent's brief must contain: the path of its WS file, the paths of
  README.md and CONTRACTS.md, the sentence "CONTRACTS.md is frozen; if you need
  a change, stop and report it instead of changing it", the list of files it
  owns, and the exit criteria to tick. Tell each agent to run its tests, bump
  the root version (ERP code) or write under [Unreleased] (tracker code), add
  the CHANGELOG section, rebase on origin/dev right before merging and
  re-check migration/version/ticket numbers, then update the Status table in
  README.md in the same PR.
- Absolute limits for every agent: no command against jinhu@10.10.10.73 or
  worker@10.10.60.14 that starts, stops, restarts or recreates a container,
  runs deploy.sh, or edits a file there; no re-login from the ERP or console;
  no secret from fb_pool_accounts, FB_POOL_KEY, the coordinator vault or
  secrets.env in a commit, fixture, log or PR body; no Postgres test against
  port 5432 or 55432; no push to the vendored monitor's upstream origin.
- When an agent reports a contract change request, stop that agent, decide
  (or ask me), update CONTRACTS.md in one PR, and tell every running agent.
- When two agents would touch the same file (packages/shared/src/fleet.ts,
  routes/fleet.ts mount, docs/DATABASE.md, docs/FEATURES.md, CHANGELOG.md),
  serialize: the later one rebases after the earlier merges.
- After each merge, re-read README.md's Status table and report to me in one
  short message: what merged, what is running, what is blocked and why.
  Never predict a running agent's result.
- Stop and ask me before: the first host-prep command on 10.10.60.14, any
  Railway prod variable, any step of the cutover, and any decision the plan
  marks as the owner's.

Begin by confirming you have read the six documents, listing the agents you
will start now with one line each, and then start them.
````
