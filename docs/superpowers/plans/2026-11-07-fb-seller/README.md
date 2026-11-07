# Facebook seller accounts: buy ads, an ERP message center, a negotiating agent

**Ticket:** [RS-565](../../../tickets/RS-565-facebook-seller-accounts-post-buy-ads-route-messenge.md) · **Owner:** jinhu · **Started:** 2026-11-07

This folder is the implementation plan, split so that several agents can work
it at once. Read this file, then [`CONTRACTS.md`](CONTRACTS.md), then your
workstream file. The orchestrator's brief is
[`ORCHESTRATOR-PROMPT.md`](ORCHESTRATOR-PROMPT.md).

## What we are building

Today the fleet only searches Marketplace. After this:

- A manager marks a pool account as a **seller**. It stops searching, posts
  "we buy" ads the managers wrote in the ERP, and reads its Marketplace inbox.
- Each post draws **random photos** from a manager-filled pool, and no photo is
  ever used twice.
- Seller conversations land in **Leads ▸ Facebook** in the ERP. An **agent**
  screens and negotiates on its own. When a deal is about to close, or a rule
  says a person is needed, the thread goes to **Needs human** and managers
  answer from the ERP.
- **All configuration is in the database**, edited in the ERP: pacing, hours,
  offer policy and the agent's prompts, rules, skills and models. The agent's
  setup is a **versioned profile** that can be shadow-run and replayed before it
  goes live.

```
Manager drafts ad ─► fb_ads ─► placement (random unused photos) ─► task ad-post ─► seller worker publishes
Seller replies ─► task inbox-sync ─► fb_threads / fb_messages ─► agent run
   agent: extract ─► rules ─► skill ─► guards ─┬─ pass ─► task msg-send ─► worker types it
                                               └─ hand-off ─► Needs human (in-app + Telegram) ─► manager replies in the ERP
```

The worker stays Python (the vendored monitor). Everything else is TypeScript
in the ERP. `rs_poster` and `rs_messenger` stay parked as the code to port
from; nothing new reads `ads.toml`.

## Owner decisions, 2026-11-07

| Decision | Choice |
| --- | --- |
| What gets posted | "We buy" ads only; the agent negotiates what we pay |
| Who drafts posts | Managers, in the ERP |
| Post photos | A manager-filled pool; random photos per post; no photo ever used twice |
| Routing | ERP message center; staff answer in the ERP. Group chats dropped |
| Agent | Sends on its own while screening and negotiating |
| When a person steps in | When a deal is about to close, plus the other hand-off rules. No dollar limit |
| Configuration | All in the DB. Selectors and step timings stay in the worker code |
| Agent flexibility | Versioned profiles: prompts, rules, skills, models; shadow and replay |
| Accounts | Dedicated seller accounts, which stop searching |
| Who answers | Managers only, no claim step |
| How it runs | Orca workers and an orchestrator, one worktree per workstream |

## Workstreams

| WS | File | Scope | Depends on | Parallel with |
| --- | --- | --- | --- | --- |
| A1 | [WS-A1-foundations.md](WS-A1-foundations.md) | Schema, shared types, seeded defaults, stubs, mounts | this folder merged | nothing; it unblocks the rest |
| A2 | [WS-A2-queue.md](WS-A2-queue.md) | Seller kinds in the task queue, report and screenshot routes | A1 | B, C, D1, D2, E |
| B | [WS-B-worker.md](WS-B-worker.md) | Seller tasks in the vendored monitor | contract only | everything |
| C | [WS-C-seller-backend.md](WS-C-seller-backend.md) | Settings, photo pools, ads, placements, threads, pacing tick, alerts | A1 | A2, B, D1, D2, E |
| D1 | [WS-D1-agent-runtime.md](WS-D1-agent-runtime.md) | Agent runtime, skill and rule registries, offer code, guards | A1 | A2, B, C, D2, E |
| D2 | [WS-D2-agent-profiles.md](WS-D2-agent-profiles.md) | Profile versions, shadow runs, replay tests, compare | A1 | A2, B, C, D1, E |
| E | [WS-E-ui.md](WS-E-ui.md) | Leads ▸ Facebook pages, Fleet worker page toggle | A1 (mocks until C, D1, D2) | A2, B, C, D1, D2 |
| R | [WS-R-review.md](WS-R-review.md) | Independent review of the merged code, then fixes | A2, B, C, D1, D2, E | nothing |
| F | [WS-F-integration-rollout.md](WS-F-integration-rollout.md) | Local end-to-end, then the live rollout | R | nothing |

```
this folder ─► A1 ─┬─► A2 ─┐
                   ├─► C  ─┤
                   ├─► D1 ─┤
                   ├─► D2 ─┼─► R ─► F.local ─► [owner yes, per step] ─► F.live
                   ├─► E  ─┤
     (contract) ───┴─► B  ─┘
```

B needs nothing merged: it builds against the worker protocol in
`CONTRACTS.md` with a fake server. The six middle workstreams meet only at the
contract: C and D1 at the `fbThreads` and agent signatures, D1 and D2 at the
profile shape and `runAgent`, E at the HTTP routes and DTOs.

## Rules for every agent

1. **Contracts first.** [`CONTRACTS.md`](CONTRACTS.md) is the one source for
   tables, routes, payloads, signatures, settings and error shapes. It is
   frozen. If you need a change, stop and report it to the orchestrator; do
   not change it yourself. The orchestrator changes it in one PR and tells
   every running agent.
2. **Own your files.** Each workstream lists the paths it owns. A1 is the only
   workstream that edits the shared mount points (`apps/backend/src/index.ts`,
   `routes/fleet.ts` mount lines, `server.ts` loop starts,
   `apps/frontend/src/lib/desktopNav.ts`, `lib/route.ts`, `DesktopApp.tsx`).
   After A1, everyone fills in their own stub files. Shared files you may
   append to at merge time: `CHANGELOG.md`, `docs/FEATURES.md`,
   `docs/DATABASE.md`, the i18n files (your own keys, prefix `fbs_`).
3. **One worker, one Orca worktree, one branch** off `origin/dev`, PR to
   `dev`, squash-merge. The orchestrator merges one PR at a time. Rebase on
   `origin/dev` right before merging and re-check the migration number, root
   version and CHANGELOG heading: other sessions take numbers too.
4. **Versions and changelog.** ERP code bumps the root `package.json` minor
   and adds a `## [X.Y.Z]` section in the same PR. Tracker code writes under
   `[Unreleased]` in `trackers/facebook/CHANGELOG.md`; only F cuts a tracker
   release.
5. **Never touch the live fleet.** No command on `10.10.10.73`,
   `10.10.60.14`, `10.10.60.10` or `oci-sg-1` that starts, stops, restarts or
   recreates a container, runs `deploy.sh`, or edits a file. No re-login. No
   fleet release (`POST /api/fleet/releases`). No Railway variable. No push to
   `main`. No live Facebook action. Every container start is a Facebook login
   (root `AGENTS.md`, first rule). F.live's steps each need the owner's yes.
6. **Tests before the PR.** `pnpm typecheck`; backend
   `pnpm --filter recycle-erp-backend test` (one file:
   `cd apps/backend && npx vitest run tests/foo.test.ts`); frontend
   `pnpm --filter recycle-erp-frontend test`; tracker suites per
   `trackers/facebook/AGENTS.md`. Tracker Postgres tests never on 5432 or
   55432.
7. **Local servers.** Pick your own free ports. Never `pkill` a dev server:
   kill your own port's PID and its `tsx` parent only.
8. **Secrets.** Nothing from `fb_pool_accounts`, `FB_POOL_KEY`, the
   coordinator vault or `secrets.env` goes into a commit, fixture, log or PR
   body. No real seller conversations in fixtures; write them.
9. **Git.** Commit author is `13999458+JinhuW@users.noreply.github.com`.
   Stage by explicit path. End commit messages with the Co-Authored-By line
   the session gives you.
10. **Report back here.** When your PR merges, tick your exit criteria in your
    workstream file and update the Status table below in the same PR.

## Status

| WS | State | PR | Version | Notes |
| --- | --- | --- | --- | --- |
| A1 | PR open | #1145 | 1.437.0 | migration 0232; see the WS file's Outcome |
| A2 | PR open | | 1.438.0 | migration 0233; see the WS file's Outcome |
| B | PR open | #1146 | tracker [Unreleased], monitor pin `d788039` | no release cut; fixtures are guesses until F.live refreshes them |
| C | not started | | | |
| D1 | not started | | | |
| D2 | not started | | | |
| E | not started | | | |
| R | not started | | | |
| F.local | not started | | | |
| F.live | not started | | | each step needs the owner's yes |
