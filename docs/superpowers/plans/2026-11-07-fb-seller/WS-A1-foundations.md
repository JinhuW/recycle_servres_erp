# WS-A1 — Foundations

One small PR that everything else builds on. Merge it as soon as CI is green.

## Owns

- `apps/backend/migrations/<next>_fb_seller.sql` (0232 at the time of writing; recheck) and `docs/DATABASE.md` sections for every new table and column.
- `packages/shared/src/fbSeller.ts`, its export from `packages/shared/src/index.ts`, and the `shared/fleet.ts` additions named in CONTRACTS §4.1–4.3 (kinds, `FLEET_SELLER_TASK_KINDS`, `FLEET_SELLER_MIN_WORKER_VERSION = '99.0.0'`, the `HandedTask` union, `SellerReport`, `InboxThread`, `SellerTaskPayload`).
- Mount points, once: `apps/backend/src/index.ts` (mount `/api/fb-seller` and `/api/fb-agent`), `src/server.ts` (start `startFbSellerLoop` and `startFbAgentLoop`), `src/routes/fleet.ts` (nothing new; the worker routes mount inside `fleet/claim.ts`'s `worker` app or a sibling A2 owns — leave a comment where A2 will mount `/seller`).
- Stub modules with the exact contract signatures, each throwing `not implemented` or returning the documented neutral value:
  - `src/routes/fbSeller.ts`, `src/routes/fbAgent.ts` (empty Hono apps with the manager guard and mirror refusal wired),
  - `src/services/fbConfig.ts` (`loadFbSellerSettings` really reads the seeded row — callers need it),
  - `src/services/fbThreads.ts`, `src/services/fbSellerReports.ts` (`applySellerReport` → `{ accepted: true }`), `src/lib/fbSellerAlert.ts`,
  - `src/services/fbAgent/index.ts` (`enqueueAgentRun` no-op, `decide` throws, `startFbAgentLoop` no-op), `src/services/fbAgentEval.ts`,
  - `src/fleet/seller.ts` (`enqueueSellerTask` throws).
- Frontend: `desktopNav.ts` entry `leadsFacebook` (manager only), `lib/route.ts` paths from CONTRACTS §8, `DesktopApp.tsx` view, and a stub page `pages/desktop/leads/fb/FbSellerPage.tsx` that renders the tab bar and "Coming soon" per tab. i18n keys for the nav label and tab names (prefix `fbs_`), English and Chinese.

## Do

1. Read CONTRACTS §3 and write the migration exactly; confirm `fleet_tasks_state_check` is the constraint's real name (`\d fleet_tasks` on a local DB) before dropping it.
2. Seed `fb_seller_settings` with CONTRACTS §2.1's defaults and `fb_agent_profiles` `default` v1 `active` with CONTRACTS §6.3/§6.5's skills, rules and parameters. Write the v1 prompts plainly: a polite buyer for Recycle Servers (Denver), asks for part numbers, quantities, condition and a photo; never names a price itself (the placeholder `{{offer}}` is the only way a number appears); never claims to be human.
3. Make sure nothing in search changes: the existing fleet suites must pass untouched. `handed()`/`taskRows` changes belong to A2, but the type union must compile against the current `claim.ts` (search tasks still carry city and item).
4. Version bump (minor) and `CHANGELOG.md` section: "Foundations for Facebook seller accounts (RS-565): tables, settings, the default agent profile; nothing visible yet beyond an empty Leads ▸ Facebook page for managers."

## Exit criteria

- [x] `scripts/migrate.mjs` applies the migration on a fresh DB and on a copy with fleet rows (seed + a few `fleet_tasks`), and the test template builds.
- [x] `pnpm typecheck`, backend and frontend suites pass with no fleet test edited.
- [x] The seeded settings validate against the TS type (a unit test parses them).
- [x] Leads ▸ Facebook shows for a manager, not for a purchaser.
- [x] `docs/DATABASE.md` updated, *As of* line bumped.
- [x] README Status row updated.

## Outcome

Migration `0232_fb_seller.sql`, v1.437.0. Notes for the workstreams after A1:

- `fleet_tasks_state_check` was the real name (0206's inline check); confirmed on
  a DB with fleet rows before the migration ran.
- Every FK has an index, including the user columns (`created_by` and the like).
  `fb_thread_events` is append-only by trigger, like the settings history.
- `HandedTask`'s search variant keeps the existing `why` field. `claim.ts`'s
  `PickRow.kind` is now `FleetSearchTaskKind` (one line), so the union compiles;
  A2 widens it when `handed()` learns the seller shape.
- `FLEET_TASK_STATES` gained `uncertain`; `PERF_PAGES` gained `leadsFacebook`.
- `FB_SELLER_DEFAULT_SETTINGS` in `shared/fbSeller.ts` is the seeded value,
  typed; the backend test holds the row to it.
- Return types the contract left open: `saveCaseFromThread` →
  `{ caseId }`, `enqueueSellerTask` → `{ taskId } | null` (null: an open task
  with that ref exists). Change them freely in your own PR.
- `startFbSellerLoop` lives in `src/services/fbPacing.ts` (C's tick file).
  Both loops return `void` as CONTRACTS §6.2 says, so `server.ts` calls them
  after the `loops` list and shutdown cannot stop them; a loop that should stop
  on SIGTERM needs a contract change to return `{ stop() }`.
- Rule, skill and context types (`AgentRule`, `AgentSkill`, `RuleContext`,
  `SkillContext`) are left to D1; the wire types (`ParamSchema`,
  `RegistryEntry`, `EvalExpectation`) are in shared.
